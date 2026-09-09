export const PROGRESS_UPDATE_MS = 10_000;

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const remainder = seconds % 60;
  if (hours) return `${hours}小時${minutes}分${remainder}秒`;
  if (minutes) return `${minutes}分${remainder}秒`;
  return `${remainder}秒`;
}
