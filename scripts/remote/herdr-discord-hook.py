#!/usr/bin/env python3
"""Herdr Discord bridge Stop hook for REMOTE machines (ISSUE-045).

No Node needed. Reads a CLI hook payload on stdin and forwards the final reply to the
bridge's hook socket (a unix socket the bridge reverse-forwards with `ssh -R`, see the
machine's `hookSocket` setting). Any failure is silent: the bridge falls back to its
screen parser. Supports agy (Antigravity) Stop and Claude/Codex-style Stop payloads.
"""
import json
import os
import socket
import sys
import time

SOCKET = os.environ.get("HERDR_DISCORD_HOOK_SOCKET") or os.path.expanduser(
    "~/.config/herdr-discord-bridge/hooks.sock"
)


def agy_final_message(text):
    steps = []
    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            step = json.loads(line)
        except ValueError:
            continue
        if isinstance(step, dict):
            steps.append(step)
    last_user = -1
    for index, step in enumerate(steps):
        if step.get("type") == "USER_INPUT":
            last_user = index
    for index in range(len(steps) - 1, last_user, -1):
        step = steps[index]
        if step.get("type") != "PLANNER_RESPONSE" or step.get("tool_calls"):
            continue
        content = step.get("content")
        if isinstance(content, str) and content.strip():
            return content.strip()
    return ""


def send(event):
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(3)
            client.connect(SOCKET)
            client.sendall((json.dumps(event) + "\n").encode())
    except Exception:
        pass


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return
    if not isinstance(payload, dict):
        return
    pane = os.environ.get("HERDR_PANE_ID") or None

    if "conversationId" in payload and "terminationReason" in payload and "hook_event_name" not in payload:
        sys.stdout.write("{}\n")
        sys.stdout.flush()
        if payload.get("terminationReason") != "NO_TOOL_CALL" or payload.get("fullyIdle") is False:
            return
        path = payload.get("transcriptPath")
        message = ""
        for _ in range(4):
            if message or not isinstance(path, str):
                break
            try:
                with open(path, encoding="utf-8") as handle:
                    message = agy_final_message(handle.read())
            except Exception:
                pass
            if not message:
                time.sleep(0.25)
        if message:
            send({"event": "Stop", "sessionId": payload["conversationId"], "paneId": pane, "message": message})
        return

    if payload.get("hook_event_name") == "Stop" and not payload.get("agent_id"):
        session = payload.get("session_id")
        message = payload.get("last_assistant_message")
        if isinstance(session, str) and session and isinstance(message, str) and message:
            send({"event": "Stop", "sessionId": session, "paneId": pane, "message": message})


main()
