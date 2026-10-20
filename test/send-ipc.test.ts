import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendRequest, startSendServer } from "../src/send-ipc.js";

test("send socket round-trips a request and is user-only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bsend-"));
  const path = join(dir, "s.sock");
  const stop = await startSendServer(
    async (request) => ({
      ok: true,
      message: `${request.paneId}|${request.text}|${request.files?.length}`,
    }),
    path,
  );
  try {
    if (process.platform !== "win32")
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    const reply = await sendRequest(
      { paneId: "w1:p1", text: "hi", files: ["/a"] },
      path,
    );
    assert.deepEqual(reply, { ok: true, message: "w1:p1|hi|1" });
  } finally {
    stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid requests and a missing bridge fail clearly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bsend-"));
  const path = join(dir, "s.sock");
  const missing = await sendRequest({ paneId: "x" }, path, 2000);
  assert.equal(missing.ok, false);
  assert.match(missing.message, /not running/);
  const stop = await startSendServer(
    async () => ({ ok: true, message: "" }),
    path,
  );
  try {
    const { connect } = await import("node:net");
    const answer = await new Promise<string>((resolve) => {
      const s = connect(path);
      let d = "";
      s.on("data", (c) => (d += c));
      s.on("end", () => resolve(d));
      s.on("connect", () => s.write('{"paneId":1}\n'));
    });
    assert.equal(JSON.parse(answer).ok, false);
  } finally {
    stop();
    await rm(dir, { recursive: true, force: true });
  }
});
