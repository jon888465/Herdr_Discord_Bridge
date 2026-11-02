import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../src/redact.js";

// 樣本在執行時拼接，避免原始碼字面量被 secret scanning 當成真的憑證。
const cat = (...parts: string[]): string => parts.join("");
const FAKE = "FAKEFAKEFAKE";

// [名稱, 含機敏內容的文字, 不得再出現的片段]
const secrets: Array<[string, string, string]> = [
  [
    "傳統 GitHub token",
    cat("used gh", "p_", FAKE, "0123456789ABCD here"),
    cat("gh", "p_", FAKE),
  ],
  [
    "細粒度 GitHub token",
    cat("used github_", "pat_", FAKE, "0123456789_", FAKE, " here"),
    cat("github_", "pat_", FAKE),
  ],
  ["sk- 金鑰", cat("key s", "k-", FAKE, FAKE, " here"), cat("s", "k-", FAKE)],
  [
    "Slack token",
    cat("t x", "oxb-", "1234567890-", FAKE, " here"),
    cat("x", "oxb-", "1234567890"),
  ],
  [
    "AWS access key id",
    cat("id AK", "IA", FAKE, "0123 here"),
    cat("AK", "IA", FAKE),
  ],
  [
    "JWT",
    cat(
      "jwt ey",
      "JhbGciOiJIUzI1NiJ9.",
      "eyJmYWtlIjoxfQ.",
      FAKE,
      FAKE,
      " here",
    ),
    cat("ey", "JhbGciOiJIUzI1NiJ9"),
  ],
  [
    "Authorization: Bearer",
    cat("Authorization: Bearer ", FAKE, FAKE),
    cat(FAKE, FAKE),
  ],
  [
    "單獨的 Bearer",
    cat("curl -H 'x: Bearer ", FAKE, FAKE, "' url"),
    cat(FAKE, FAKE),
  ],
  ["password=", cat("password=", FAKE, "PASS"), cat(FAKE, "PASS")],
  ["GITHUB_TOKEN=", cat("GITHUB_TOKEN=", FAKE, "TOK"), cat(FAKE, "TOK")],
  ["API_KEY=", cat("API_KEY=", FAKE, "APIKEY"), cat(FAKE, "APIKEY")],
  ["client_secret=", cat("client_secret=", FAKE, "CS"), cat(FAKE, "CS")],
  ["secret_key:", cat("secret_key: ", FAKE, "SK"), cat(FAKE, "SK")],
  [
    "含帳密的網址",
    cat("git clone https://user:", FAKE, "URLPASS@example.invalid/repo.git"),
    cat(FAKE, "URLPASS"),
  ],
  [
    "資料庫連線字串",
    cat("postgres://user:", FAKE, "DBPASS@db.invalid:5432/app"),
    cat(FAKE, "DBPASS"),
  ],
  [
    "私鑰區塊",
    cat(
      "-----BEGIN OPENSSH PRIV",
      "ATE KEY-----\n",
      FAKE,
      "KEYBODY\n-----END OPENSSH PRIV",
      "ATE KEY-----",
    ),
    cat(FAKE, "KEYBODY"),
  ],
];

for (const [name, text, leaked] of secrets) {
  test(`redactSecrets removes: ${name}`, () => {
    const out = redactSecrets(text);
    assert.notEqual(out, text);
    assert.equal(out.includes(leaked), false, `still contains ${leaked}`);
    assert.match(out, /\[redacted/);
  });
}

test("a private key block cut off before its END line is redacted to the end of the text", () => {
  const text = cat(
    "before\n-----BEGIN RSA PRIV",
    "ATE KEY-----\n",
    FAKE,
    "TRUNCATED",
  );
  const out = redactSecrets(text);
  assert.equal(out.includes(cat(FAKE, "TRUNCATED")), false);
  assert.ok(out.startsWith("before\n"));
});

test("URL query parameters whose names look like secrets are redacted and the rest of the URL is kept", () => {
  const out = redactSecrets(
    cat(
      "see https://example.invalid/a/b?page=2&access_token=",
      FAKE,
      "QT&sort=asc&api_key=",
      FAKE,
      "QK#frag",
    ),
  );
  assert.equal(out.includes(cat(FAKE, "QT")), false);
  assert.equal(out.includes(cat(FAKE, "QK")), false);
  assert.ok(out.includes("page=2"));
  assert.ok(out.includes("sort=asc"));
  assert.ok(out.includes("https://example.invalid/a/b?"));
  assert.ok(out.endsWith("#frag"));
});

const benign = [
  "commit 0123456789abcdef0123456789abcdef01234567",
  "tests passed, PR opened at https://github.com/o/r/pull/9",
  "git clone ssh://git@github.com/o/r.git",
  "git clone git@github.com:o/r.git",
  "https://example.com/path?page=2&sort=asc",
  "Bearer of bad news",
  "the token count is shown in the dashboard",
  "一般的中文句子，沒有任何機敏內容。",
];

for (const text of benign) {
  test(`redactSecrets leaves ordinary text alone: ${text.slice(0, 40)}`, () => {
    assert.equal(redactSecrets(text), text);
  });
}

test("redactSecrets is idempotent", () => {
  for (const [, text] of secrets) {
    const once = redactSecrets(text);
    assert.equal(redactSecrets(once), once);
  }
});
