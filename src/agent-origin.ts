/**
 * 記住「最近是哪個 Discord 對話把 prompt 派給某個 Agent」（含私訊）。
 *
 * 沒有對應 thread 的 pane 通常是使用者透過 Discord 私訊對話的 Agent；`herdr-discord-send`
 * 與輸出標記在找不到 thread 對應時，改送回這個來源對話。只存在記憶體，bridge 重啟後清空。
 */
export interface OriginChannel {
  send(payload: unknown): Promise<unknown>;
}

/** 超過這段時間沒有新的 Discord 派發，就不再當作「目前的對話」，避免誤送到舊的對話。 */
export const ORIGIN_TTL_MS = 12 * 60 * 60 * 1000;

const origins = new Map<string, { channel: OriginChannel; at: number }>();

export function recordAgentOrigin(
  terminalId: string,
  channel: unknown,
  now = Date.now(),
): void {
  if (
    channel &&
    typeof (channel as OriginChannel).send === "function" &&
    terminalId
  )
    origins.set(terminalId, { channel: channel as OriginChannel, at: now });
}

export function agentOrigin(
  terminalId: string,
  now = Date.now(),
): OriginChannel | undefined {
  const found = origins.get(terminalId);
  if (!found) return undefined;
  if (now - found.at > ORIGIN_TTL_MS) {
    origins.delete(terminalId);
    return undefined;
  }
  return found.channel;
}

export function clearAgentOrigins(): void {
  origins.clear();
}
