// 卡片事件與異動專案共用的欄位驗證（ADR-0002 決定 11）。
// 每個函式從 fields 取出一個欄位並驗證格式，不合格就丟 FieldError 並指出欄位名稱。

import { redactSecrets } from "./redact.js";

export class FieldError extends Error {}

export type Fields = Record<string, unknown>;

export function bad(field: string, expected: string): never {
  throw new FieldError(`invalid ${field} (${expected})`);
}

export function text(
  fields: Fields,
  key: string,
  pattern: RegExp,
  expected: string,
): string {
  const value = fields[key];
  if (typeof value !== "string" || !pattern.test(value)) bad(key, expected);
  return value;
}

export function oneOf<T extends string>(
  fields: Fields,
  key: string,
  allowed: readonly T[],
): T {
  const value = fields[key];
  if (
    typeof value !== "string" ||
    !(allowed as readonly string[]).includes(value)
  )
    bad(key, `one of ${allowed.join(", ")}`);
  return value as T;
}

export function integer(
  fields: Fields,
  key: string,
  min: number,
  max: number,
): number {
  const value = fields[key];
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    bad(key, `integer ${min} to ${max}`);
  return value;
}

export const CONTROL = /[\u0000-\u001F\u007F]/;
export const MACHINE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
export const AGENT = /^[A-Za-z0-9._-]{1,40}$/;
export const BRANCH = /^[A-Za-z0-9._/-]{1,80}$/;
export const SHA = /^[0-9a-f]{7,40}$/;
export const TASK_ID = /^[A-Za-z0-9._-]{1,64}$/;
export const SNAKE = /^[a-z][a-z0-9_]{0,31}$/;

export function absolutePath(fields: Fields, key: string): string {
  const value = fields[key];
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    Array.from(value).length > 120 ||
    CONTROL.test(value) ||
    value.includes(" | ")
  )
    bad(
      key,
      "absolute path, at most 120 characters, no control characters or ' | '",
    );
  return value;
}

/** 網址先驗證格式，再移除帳密與像憑證的查詢參數（決定 11 規則 3）。 */
export function url(fields: Fields, key: string): string {
  const value = fields[key];
  if (
    typeof value !== "string" ||
    !/^https?:\/\/\S+$/.test(value) ||
    value.length > 150 ||
    CONTROL.test(value)
  )
    bad(key, "http(s) URL without spaces, at most 150 characters");
  return redactSecrets(value);
}

export function sha12(fields: Fields, key: string): string {
  return text(fields, key, SHA, "7 to 40 lowercase hex characters").slice(
    0,
    12,
  );
}
