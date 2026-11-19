// 遠端 codex 的 session 查詢（ISSUE-175）：用真的 sh 對暫存的 CODEX_HOME 跑固定腳本，規則要與本機搜尋相同。
import test, { type TestContext } from "node:test";
import { equal, deepEqual as eq } from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_SESSION_SCRIPT, findRemoteCodexSession } from "../src/remote-codex-session.js";
import { RemoteFailure, type RemoteExec } from "../src/remote-checkout.js";

const NONCE = "ab12cd34ef56ab12cd34ef56ab12cd34";
const ID = (n: number) => `01a1f29${n}-0000-7000-8000-000000000001`;
const rollout = (id: string) => `rollout-2026-11-19T15-01-36-${id}.jsonl`;
const meta = (extra: object = {}) => JSON.stringify({ type: "session_meta", payload: { thread_source: "user", ...extra } });

async function pod(t: TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "codex-session-")));
  const home = join(base, "home");
  const day = join(home, ".codex/sessions/2026/11/19");
  await mkdir(day, { recursive: true });
  const exec: RemoteExec = (argv) => new Promise((resolve) => execFile(argv[0]!, argv.slice(1), { env: { ...process.env, HOME: home, CODEX_HOME: "" } }, (e, stdout) => resolve({ code: e ? Number(e.code) : 0, stdout })));
  const usable = !(await exec(["sh", "-c", "command -v find && command -v grep && command -v head"], 5000)).code;
  if (!usable) t.skip("no find/grep/head");
  const put = (id: string, first: string, body = `prompt ${NONCE}`) => writeFile(join(day, rollout(id)), `${first}\n${body}\n`);
  return { base, home, day, exec, put, usable };
}

test("the script has no control characters, no embedded values, and takes the nonce as an argument", () => {
  equal(/[\u0000-\u001F]/.test(CODEX_SESSION_SCRIPT), false);
  equal(CODEX_SESSION_SCRIPT.includes(NONCE), false);
  equal(CODEX_SESSION_SCRIPT.includes('"$1"'), true);
});

test("real sh: exactly one real session containing the nonce is returned, subagents and other files are ignored", async (t) => {
  const { exec, put, usable } = await pod(t);
  if (!usable) return;
  await put(ID(6), meta());
  await put(ID(7), meta({ thread_source: "subagent" }));
  await put(ID(8), meta(), "no nonce here");
  eq(await findRemoteCodexSession(exec, NONCE, Date.now() - 1000), { kind: "id", value: ID(6) });
});

test("real sh: two real sessions with the nonce, or none, are unknown", async (t) => {
  const { exec, put, usable } = await pod(t);
  if (!usable) return;
  equal(await findRemoteCodexSession(exec, NONCE, Date.now() - 1000), undefined);
  await put(ID(6), meta());
  await put(ID(9), meta());
  equal(await findRemoteCodexSession(exec, NONCE, Date.now() - 1000), undefined);
});

test("real sh: a source.subagent object in the first line is also treated as a subagent", async (t) => {
  const { exec, put, usable } = await pod(t);
  if (!usable) return;
  await put(ID(6), meta());
  await put(ID(7), JSON.stringify({ type: "session_meta", payload: { source: { subagent: { parent: "x" } } } }));
  eq(await findRemoteCodexSession(exec, NONCE, Date.now() - 1000), { kind: "id", value: ID(6) });
});

test("real sh: files older than the turn are not candidates", async (t) => {
  const { exec, day, put, usable } = await pod(t);
  if (!usable) return;
  await put(ID(6), meta());
  const old = new Date(Date.now() - 3 * 3600_000);
  await utimes(join(day, rollout(ID(6))), old, old);
  equal(await findRemoteCodexSession(exec, NONCE, Date.now() - 1000), undefined);
  eq(await findRemoteCodexSession(exec, NONCE, Date.now() - 4 * 3600_000), { kind: "id", value: ID(6) });
});

test("real sh: a symlinked sessions directory and a missing one are treated as no session", async (t) => {
  const { base, home, exec, put, usable } = await pod(t);
  if (!usable) return;
  await put(ID(6), meta());
  const real = join(home, ".codex/sessions");
  const moved = join(base, "elsewhere");
  await rename(real, moved);
  await symlink(moved, real);
  equal(await findRemoteCodexSession(exec, NONCE, Date.now() - 1000), undefined);
  await rm(real);
  equal(await findRemoteCodexSession(exec, NONCE, Date.now() - 1000), undefined);
});

test("an invalid nonce never reaches the remote, and remote failures are unknown without leaking detail", async (t) => {
  let called = 0;
  const lines: string[] = [];
  t.mock.method(console, "error", (...a: unknown[]) => void lines.push(a.join(" ")));
  const exec: RemoteExec = async () => {
    called++;
    throw new RemoteFailure("連線失敗", "secret detail from the remote", true);
  };
  equal(await findRemoteCodexSession(exec, "not-hex; rm -rf /", 0), undefined);
  equal(called, 0);
  equal(await findRemoteCodexSession(exec, NONCE, 0), undefined);
  equal(called, 1);
  equal(lines.join("\n").includes("secret detail"), false);
  equal(await findRemoteCodexSession(async () => ({ code: 1, stdout: `R ${rollout(ID(6))}\n` }), NONCE, 0), undefined);
});

test("output parsing: only R lines with a valid rollout name count, and the same session twice is one session", async () => {
  const out = `R ${rollout(ID(6))}\nR ${rollout(ID(6))}\nS ${rollout(ID(7))}\nX ${rollout(ID(8))}\nR not-a-rollout\n\nR${rollout(ID(9))}\n`;
  eq(await findRemoteCodexSession(async () => ({ code: 0, stdout: out }), NONCE, 0), { kind: "id", value: ID(6) });
  equal(await findRemoteCodexSession(async () => ({ code: 0, stdout: `R ${rollout(ID(6))}\nR ${rollout(ID(7))}\n` }), NONCE, 0), undefined);
});
