import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { stripAnsi } from "./format.js";
import { CodexTranscript, sameAgentSession } from "./response-stream.js";
import type { AgentRecord, ReadSource } from "./types.js";
import type { OrchestrationPort } from "./team-orchestration.js";

export interface TeamTurnContext {
  taskId: string;
  phase: "planning" | "assignment" | "synthesis";
  assignmentId?: string;
}

const sources: ReadSource[] = [
  "recent_unwrapped",
  "recent",
  "visible",
  "detection",
];

/** A request owns a fresh response envelope, never a pane's old idle/output. */
export async function runTeamTurn(
  agent: AgentRecord,
  instruction: string,
  herdr: OrchestrationPort,
  timeoutMs: number,
  lines: number,
  context?: TeamTurnContext,
): Promise<{ state: "done" | "blocked"; text: string; terminal: boolean }> {
  const nonce = randomBytes(16).toString("hex");
  const begin = `BRIDGE_BEGIN_${nonce}`;
  const end = `BRIDGE_END_${nonce}`;
  // Deliberately describe END before BEGIN: an echoed prompt cannot form a frame.
  const prompt = [
    instruction,
    "Response transport: put your final answer inside the markers below. Do not emit these markers in commentary or tool output. Only emit the closing marker after all work and the final report are complete.",
    `Closing marker (last line): ${end}`,
    `Opening marker (first line): ${begin}`,
    "Between them put only the requested result. Do not repeat these instructions.",
    context
      ? "Debug context: taskId=" +
        context.taskId +
        " phase=" +
        context.phase +
        " assignmentId=" +
        (context.assignmentId || "-") +
        " paneId=" +
        agent.pane_id +
        " agent=" +
        (agent.agent || "unknown") +
        " session=" +
        sessionKey(agent) +
        " begin=" +
        begin +
        " end=" +
        end
      : "Debug context: paneId=" +
        agent.pane_id +
        " agent=" +
        (agent.agent || "unknown") +
        " begin=" +
        begin +
        " end=" +
        end,
  ].join("\n");
  const baseline = new Map<ReadSource, string>();
  for (const source of sources) {
    try {
      baseline.set(source, await herdr.readAgent(agent.pane_id, source, lines));
    } catch {
      /* One unsupported read source must not disable the others. */
    }
  }
  let transcript = await CodexTranscript.connect(agent, prompt);
  // 優先使用 Herdr 的 atomic agent.prompt(wait=...)，確保發送與首次 settled
  // lifecycle 綁在同一個 request；不支援時才 fallback 到 promptAgent + waitAgent。
  let promptSettled: AgentRecord | undefined;
  let promptStalled = false;
  try {
    promptSettled = herdr.promptAgentAndWait
      ? await herdr.promptAgentAndWait(agent.pane_id, prompt, timeoutMs)
      : (await herdr.promptAgent(agent.pane_id, prompt), undefined);
  } catch (error) {
    if (!isPromptStalled(error)) throw error;
    // Herdr may have accepted the prompt but failed to observe a lifecycle change.
    // Do not resend: continue reading this turn's unique marker envelope.
    promptStalled = true;
  }
  if (promptSettled && promptSettled.agent_status === "blocked")
    return {
      state: "blocked",
      text: "Agent is blocked; no completed report for this request",
      terminal: false,
    };
  // 這是本次 Lead／Worker turn 的 report 等待期限；逾時不得以舊 terminal 輸出結案。
  const deadline = Date.now() + timeoutMs;
  let lastStatus = promptStalled ? "prompt_stalled" : "pending";
  // agent.prompt(wait=...) already waited for this request. Reusing its
  // settled record avoids spending a second timeout on agent.wait.
  let current = promptSettled;
  do {
    // atomic prompt 已回傳 settled record 時不再重複消耗另一個完整 wait timeout。
    if (!current)
      current = await herdr.waitAgent(
        agent.pane_id,
        ["idle", "done", "blocked", "unknown"],
        Math.max(1, deadline - Date.now()),
      );
    if (
      !current ||
      current.pane_id !== agent.pane_id ||
      current.terminal_id !== agent.terminal_id ||
      current.workspace_id !== agent.workspace_id ||
      current.agent !== agent.agent ||
      !sameAgentSession(current.agent_session, agent.agent_session)
    )
      throw new Error(
        `Agent identity changed while waiting for ${agent.pane_id}`,
      );
    lastStatus = current.agent_status;
    if (lastStatus === "blocked")
      return {
        state: "blocked",
        text: "Agent is blocked; no completed report for this request",
        terminal: false,
      };
    if (lastStatus === "unknown")
      throw new Error(`Agent ${agent.pane_id} ended in unknown`);

    if (transcript) {
      try {
        await transcript.poll();
      } catch {
        transcript = undefined;
      }
      if (transcript?.turn.completed) {
        const text =
          extractFrame(transcript.turn.final, begin, end) ??
          transcript.turn.final.trim();
        if (!text)
          throw new Error(`Agent ${agent.pane_id} completed without a report`);
        return { state: "done", text, terminal: false };
      }
    }
    // An available structured turn that is still pending is authoritative.
    // In particular, do not fall back to its prompt echo during an early idle.
    if (["idle", "done"].includes(lastStatus) && !transcript?.turn.completed) {
      for (const source of sources) {
        let output: string;
        try {
          output = await herdr.readAgent(agent.pane_id, source, lines);
        } catch {
          continue;
        }
        if (output === baseline.get(source)) continue;
        const text = extractFrame(output, begin, end);
        if (text !== undefined) {
          if (!text.trim())
            throw new Error(
              `Agent ${agent.pane_id} completed without a report`,
            );
          return { state: "done", text, terminal: true };
        }
      }
    }
    current = undefined;
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(100, remaining));
  } while (Date.now() < deadline);
  throw new Error(
    `Timed out waiting for current response from ${agent.pane_id} (last state: ${lastStatus}); no verified completion`,
  );
}

function isPromptStalled(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "agent_prompt_stalled"
  );
}

function sessionKey(agent: AgentRecord): string {
  const session = agent.agent_session;
  if (!session || typeof session !== "object") return "none";
  const value = (session as { value?: unknown }).value;
  return typeof value === "string" ? value : "unknown";
}

function extractFrame(
  output: string,
  begin: string,
  end: string,
): string | undefined {
  const text = stripAnsi(output);
  // Markers may themselves wrap in a narrow terminal; body whitespace is untouched.
  const pattern = (marker: string) =>
    new RegExp(marker.split("").join("\\s*"), "g");
  const starts = [...text.matchAll(pattern(begin))];
  const start = starts.at(-1);
  if (!start) return;
  const offset = start.index! + start[0].length;
  const finish = pattern(end).exec(text.slice(offset));
  if (!finish) return;
  return text.slice(offset, offset + finish.index).trim();
}
