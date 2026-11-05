import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookReplyTrusted } from "../src/codex-session.js";
import type { AgentRecord } from "../src/types.js";

const OWN = "01a1a9e0-0000-7000-8000-000000000001";
const OTHER = "01a1a9e0-0000-7000-8000-000000000002";

function codexHome() {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  const day = join(home, "sessions", "2026", "11", "05");
  mkdirSync(day, { recursive: true });
  const write = (id: string, cwd: string) =>
    writeFileSync(
      join(day, `rollout-2026-11-05T10-00-00-${id}.jsonl`),
      JSON.stringify({ type: "session_meta", payload: { id, cwd } }) +
        "\n" +
        JSON.stringify({ type: "event_msg", payload: {} }) +
        "\n",
    );
  write(OWN, "/work/project");
  write(OTHER, "/work/another");
  return home;
}

const pane = (over: Partial<AgentRecord>): AgentRecord => ({
  pane_id: "w4:p1",
  terminal_id: "t",
  workspace_id: "w4",
  tab_id: "w4:t1",
  agent: "codex",
  agent_status: "idle",
  cwd: "/work/project",
  foreground_cwd: "/work/project",
  agent_session: { kind: "id", value: OWN },
  ...over,
});

// ISSUE-090：codex 的 hook 事件記在 daemon 啟動時的 pane（w4:p1），該 pane 的 agent_session
// 可能是別的 codex 的 session；hook 訊息沒有 nonce，所以只在 rollout 的工作目錄對得上時才採用。
test("a codex hook reply is trusted only when the session's rollout cwd is this pane's cwd", async () => {
  const home = codexHome();
  try {
    assert.equal(await hookReplyTrusted(pane({}), home), true);
    assert.equal(
      await hookReplyTrusted(
        pane({ agent_session: { kind: "id", value: OTHER } }),
        home,
      ),
      false,
      "another codex's session on this pane",
    );
    assert.equal(
      await hookReplyTrusted(pane({ agent_session: undefined }), home),
      false,
      "no session: the pane cannot be matched to a hook event",
    );
    assert.equal(
      await hookReplyTrusted(
        pane({
          agent_session: {
            kind: "id",
            value: "01a1a9e0-0000-7000-8000-0000000000ff",
          },
        }),
        home,
      ),
      false,
      "no rollout for the session yet",
    );
    assert.equal(
      await hookReplyTrusted(
        pane({ cwd: "/elsewhere", foreground_cwd: "/elsewhere" }),
        home,
      ),
      false,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("agents other than codex keep using their hook replies unchanged", async () => {
  for (const agent of ["claude", "agy", "pi"])
    assert.equal(
      await hookReplyTrusted(
        pane({ agent, agent_session: undefined }),
        join(tmpdir(), "no-codex-home"),
      ),
      true,
      agent,
    );
});
