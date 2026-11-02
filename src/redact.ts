// 機敏內容遮蔽（ADR-0002 決定 11）。供 session handoff、公開文字與營運卡片共用。
//
// 這是黑名單式規則，只能遮蔽已知的樣式，**不保證完整**：新的 token 格式出現就可能漏掉。
// 它是補強，不是主要防線；主要防線是不把不可信的自由文字寫到不該去的地方。

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g;
// 被截斷、沒有 END 行的私鑰：從 BEGIN 到文字結尾全部遮蔽。
const PRIVATE_KEY_OPEN = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*$/;

const KNOWN_TOKENS =
  /\b(?:sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16})\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;

const AUTHORIZATION_BEARER = /(authorization\s*:\s*bearer\s+)\S+/gi;
const BARE_BEARER = /\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

// name=value、name: value 與 "name": "value"。已被遮蔽的值（[redacted…）不再處理。
const ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:token|password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_.-]*["']?\s*[=:]\s*)(?!\[redacted)(?:"[^"]*"|'[^']*'|[^\s"',;&]+)/gi;

const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi;
const URL_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^\s/@?#]*:[^\s/@?#]*@/i;
const URL_PARAM = /([?&])([^=&#\s]+)=([^&#\s]*)/g;

function secretParamName(name: string): boolean {
  const n = name.toLowerCase();
  return (
    /token|secret|passw|pwd|credential|signature|api[_-]?key|access[_-]?key/.test(
      n,
    ) ||
    /(^|[_-])auth(orization)?($|[_-])/.test(n) ||
    n === "key" ||
    n === "sig" ||
    /[_-]key$/.test(n)
  );
}

/** 移除網址中的帳密（user:pass@）與名稱像憑證的查詢參數；沒有密碼的 user@ 保留。 */
function scrubUrl(url: string): string {
  return url
    .replace(URL_USERINFO, "$1[redacted]@")
    .replace(URL_PARAM, (match, separator: string, name: string) =>
      secretParamName(name) ? `${separator}${name}=[redacted]` : match,
    );
}

export function redactSecrets(value: string): string {
  return value
    .replace(PRIVATE_KEY_BLOCK, "[redacted private key]")
    .replace(PRIVATE_KEY_OPEN, "[redacted private key]")
    .replace(URL_LIKE, scrubUrl)
    .replace(KNOWN_TOKENS, "[redacted token]")
    .replace(JWT, "[redacted token]")
    .replace(AUTHORIZATION_BEARER, "$1[redacted]")
    .replace(BARE_BEARER, "$1[redacted]")
    .replace(ASSIGNMENT, "$1[redacted]");
}
