import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeTerminalResponse } from "./cli-adapter.js";
import { stripAnsi } from "./format.js";
import {
  CodexTranscript,
  findCodexRolloutByNonce,
  hasAgentSession,
  sameAgentSession,
} from "./response-stream.js";
import type { AgentRecord, ReadSource } from "./types.js";
import type { OrchestrationPort } from "./team-orchestration.js";

export interface TeamTurnContext {
  taskId: string;
  phase: "planning" | "assignment" | "synthesis";
  assignmentId?: string;
  signal?: AbortSignal;
  beforeDispatch?: () => void;
  beforeComplete?: () => Promise<void>;
  /**
   * 該 Agent 在 `since`（毫秒時間戳）之後由 CLI hook 回報的完整最終訊息；沒有（或 hook 未啟用）
   * 回 undefined。hook 訊息不受 pane 寬度影響（ISSUE-086：Claude Code 依寬度硬換行會切斷 JSON）。
   */
  hookFinal?: (agent: AgentRecord, since: number) => string | undefined;
  /**
   * ISSUE-088：codex 的 `agent_session` 不可信，要求回合結束時用本回合 nonce 從 rollout 找出
   * 實際 session（只有 coding 的獨立 review 需要）。
   */
  observeSession?: boolean;
}

/** 終端畫面已看到框、但 hook 事件可能還在路上時，最多再等多久。 */
const HOOK_GRACE_MS = 1500;

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
  onBlocked?: (agent: AgentRecord) => void | Promise<void>,
): Promise<{
  state: "done" | "blocked";
  text: string;
  terminal: boolean;
  /**
   * 只在 `context.observeSession` 時填入。codex：用 nonce 從 rollout 找出的實際 session（找不到或不唯一則
   * undefined）。其他 CLI（ISSUE-107，如 agy 處理完第一個 prompt 才被登記 session）：回合內經過核對
   * （pane／terminal／workspace／種類沒變、session 全程一致）的 Herdr session；沒有則 undefined。
   */
  session?: { kind: string; value: string };
}> {
  const signal = context?.signal;
  const check = () => signal?.throwIfAborted();
  check();
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
        sessionKey(agent)
      : "Debug context: paneId=" +
        agent.pane_id +
        " agent=" +
        (agent.agent || "unknown"),
  ].join("\n");
  const baseline = new Map<ReadSource, string>();
  for (const source of sources) {
    try {
      baseline.set(source, await herdr.readAgent(agent.pane_id, source, lines));
    } catch {
      /* One unsupported read source must not disable the others. */
    }
  }
  check();
  const since = Date.now();
  const isCodex = Boolean(agent.agent?.toLowerCase().includes("codex"));
  // ISSUE-066：剛啟動的 Agent 派工時還沒有 session，處理完第一個 prompt 後才被 Herdr 登記。
  // 允許 session「第一次出現」（其餘身份欄位都沒變時），並記住它；之後換成別的值或消失仍是身份改變。
  let expectedSession = agent.agent_session;
  const observedSession = async (): Promise<
    { kind: string; value: string } | undefined
  > => {
    if (!context?.observeSession) return undefined;
    if (!isCodex) {
      // ISSUE-107：expectedSession 每次等待後都核對過，所以是回合內一致的 session。
      if (!hasAgentSession(expectedSession)) return undefined;
      const { kind, value } = expectedSession as {
        kind: string;
        value: string;
      };
      return { kind, value };
    }
    const match = await findCodexRolloutByNonce(nonce, since);
    return match ? { kind: "id" as const, value: match.value } : undefined;
  };
  // ISSUE-089：codex 的回覆比 pane 可視高度長時，Herdr 的終端讀取只剩最後幾列，框會遺失；
  // rollout 檔有完整、未換行的最終訊息。沒有已知 session 時用 nonce 找到 rollout。
  let rolloutTriedAt = 0;
  const hookFrame = (current: AgentRecord): string | undefined => {
    const message = context?.hookFinal?.(current, since);
    return message === undefined
      ? undefined
      : extractFrame(message, begin, end);
  };
  let transcript = await CodexTranscript.connect(agent, prompt);
  check();
  context?.beforeDispatch?.();
  check();
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
  check();
  if (!onBlocked && promptSettled && promptSettled.agent_status === "blocked")
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
    check();
    // atomic prompt 已回傳 settled record 時不再重複消耗另一個完整 wait timeout。
    if (!current)
      current = await abortable(
        herdr.waitAgent(
          agent.pane_id,
          ["idle", "done", "blocked", "unknown"],
          Math.max(1, deadline - Date.now()),
        ),
        signal,
      );
    check();
    if (
      !current ||
      current.pane_id !== agent.pane_id ||
      current.terminal_id !== agent.terminal_id ||
      current.workspace_id !== agent.workspace_id ||
      current.agent !== agent.agent
    )
      throw new Error(
        `Agent identity changed while waiting for ${agent.pane_id}`,
      );
    if (!sameAgentSession(current.agent_session, expectedSession)) {
      if (
        !hasAgentSession(expectedSession) &&
        hasAgentSession(current.agent_session)
      )
        expectedSession = current.agent_session;
      else
        throw new Error(
          `Agent identity changed while waiting for ${agent.pane_id}`,
        );
    }
    lastStatus = current.agent_status;
    if (lastStatus === "blocked" && onBlocked) {
      await onBlocked(current);
      check();
      current = undefined;
      await delay(Math.min(100, Math.max(1, deadline - Date.now())));
      continue;
    }
    if (lastStatus === "blocked")
      return {
        state: "blocked",
        text: "Agent is blocked; no completed report for this request",
        terminal: false,
      };
    if (lastStatus === "unknown")
      throw new Error(`Agent ${agent.pane_id} ended in unknown`);

    check();
    if (
      !transcript &&
      isCodex &&
      ["idle", "done"].includes(lastStatus) &&
      Date.now() - rolloutTriedAt >= 1000
    ) {
      rolloutTriedAt = Date.now();
      try {
        const match = await findCodexRolloutByNonce(nonce, since);
        if (match) transcript = CodexTranscript.fromRollout(match, prompt);
      } catch {
        /* 找不到就維持原本的終端讀取 */
      }
    }
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
        await context?.beforeComplete?.();
        check();
        return {
          state: "done",
          text,
          terminal: false,
          session: await observedSession(),
        };
      }
    }
    if (["idle", "done"].includes(lastStatus) && !transcript?.turn.completed) {
      const fromHook = hookFrame(current);
      if (fromHook !== undefined) {
        if (!fromHook)
          throw new Error(`Agent ${agent.pane_id} completed without a report`);
        await context?.beforeComplete?.();
        check();
        return {
          state: "done",
          text: fromHook,
          terminal: false,
          session: await observedSession(),
        };
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
        check();
        if (output === baseline.get(source)) continue;
        const text = extractFrame(
          normalizeTerminalResponse(agent.agent, output),
          begin,
          end,
        );
        if (text !== undefined) {
          if (!text.trim())
            throw new Error(
              `Agent ${agent.pane_id} completed without a report`,
            );
          // 畫面框可能被硬換行切斷；hook 事件通常稍後才到，寬限一下以優先使用它。
          if (context?.hookFinal) {
            const graceEnd = Math.min(deadline, Date.now() + HOOK_GRACE_MS);
            let fromHook = hookFrame(current);
            while (fromHook === undefined && Date.now() < graceEnd) {
              await delay(50);
              check();
              fromHook = hookFrame(current);
            }
            if (fromHook?.trim()) {
              await context.beforeComplete?.();
              check();
              return {
                state: "done",
                text: fromHook,
                terminal: false,
                session: await observedSession(),
              };
            }
          }
          await context?.beforeComplete?.();
          check();
          return {
            state: "done",
            text,
            terminal: true,
            session: await observedSession(),
          };
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

/** Only observational waits are raced. Dispatch must settle before cancellation cleans up. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
