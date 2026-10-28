/**
 * Antigravity（agy）的 Stop hook 不帶最終回覆，只給 `transcriptPath`；最終回覆要從
 * transcript（JSONL）取：最後一個 USER_INPUT 之後、最後一個沒有 tool_calls 的
 * PLANNER_RESPONSE 的 `content`（ISSUE-045）。
 */
export function agyFinalMessage(transcript: string): string {
  const steps: Record<string, unknown>[] = [];
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    try {
      const step = JSON.parse(line) as unknown;
      if (step && typeof step === "object")
        steps.push(step as Record<string, unknown>);
    } catch {
      /* 寫入中的最後一行可能不完整，略過 */
    }
  }
  let lastUser = -1;
  steps.forEach((step, index) => {
    if (step.type === "USER_INPUT") lastUser = index;
  });
  for (let i = steps.length - 1; i > lastUser; i--) {
    const step = steps[i];
    if (step.type !== "PLANNER_RESPONSE") continue;
    const calls = step.tool_calls;
    if (Array.isArray(calls) && calls.length) continue;
    if (typeof step.content === "string" && step.content.trim())
      return step.content.trim();
  }
  return "";
}

/** agy hook 輸入（沒有 hook_event_name）：以 conversationId＋terminationReason 辨識 Stop。 */
export function isAgyStopInput(input: Record<string, unknown>): boolean {
  return (
    typeof input.conversationId === "string" &&
    typeof input.terminationReason === "string" &&
    input.hook_event_name === undefined
  );
}
