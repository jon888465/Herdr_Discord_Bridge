import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  machineLines,
  readMachinesSection,
  sanitizeForTerminal,
  toggleView,
  viewKeyAction,
} from "../src/card-board-machines.js";
import {
  boardKeyAction,
  displayWidth,
  firstVisible,
  moveCursor,
} from "../src/card-board.js";

const machine = { id: "remote", ssh: "user@host", socket: "/tmp/herdr.sock" };

test("view switching and keys", () => {
  assert.equal(toggleView("cards"), "machines");
  assert.equal(toggleView("machines"), "cards");
  for (const key of ["\t", "m", "c"])
    assert.equal(viewKeyAction(key), "toggle");
  for (const key of ["e", "j", "q", "", "toString"])
    assert.equal(viewKeyAction(key), undefined);
});

test("machineLines empty and single machine, display width", () => {
  assert.deepEqual(machineLines([], 0, 120, 3), [
    "沒有設定任何 machine（config.json 的 machines 為空）",
  ]);
  assert.deepEqual(machineLines([machine], 0, 100, 3), [
    "> remote  user@host  /tmp/herdr.sock",
  ]);
  assert.ok(displayWidth(machineLines([machine], 0, 15, 3)[0]!) <= 14);
});

test("machineLines scrolls around cursor and at both ends", () => {
  const machines = Array.from({ length: 12 }, (_, i) => ({
    ...machine,
    id: `remote${i}`,
  }));
  for (const cursor of [0, 6, 11]) {
    const lines = machineLines(machines, cursor, 100, 5);
    assert.equal(lines.length, 5);
    assert.ok(lines.includes(`> remote${cursor}  user@host  /tmp/herdr.sock`));
  }
  assert.equal(firstVisible(0, 12, 5), 0);
  assert.equal(firstVisible(6, 12, 5), 4);
  assert.equal(firstVisible(11, 12, 5), 7);
});

test("machine cursor uses shared navigation and clamps boundaries", () => {
  for (const key of [
    "j",
    "k",
    "\x1b[A",
    "\x1b[B",
    "\x1b[5~",
    "\x1b[6~",
    "\x1b[H",
    "\x1b[F",
  ]) {
    const action = boardKeyAction(key)!;
    assert.equal(moveCursor(action, 0, 0, 5), 0);
  }
  assert.equal(moveCursor("up", 0, 12, 5), 0);
  assert.equal(moveCursor("down", 11, 12, 5), 11);
  assert.equal(moveCursor("home", 6, 12, 5), 0);
  assert.equal(moveCursor("end", 6, 12, 5), 11);
  assert.equal(moveCursor("pageDown", 0, 12, 5), 5);
  assert.equal(moveCursor("pageUp", 11, 12, 5), 6);
});

test("readMachinesSection returns only validated machines, supports JSONC", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-machines-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(
    file,
    `// example\n${JSON.stringify({ discord: { botToken: "test-secret-token-xyz" }, machines: [machine] })}`,
  );
  const result = readMachinesSection(file);
  assert.deepEqual(result, { ok: true, machines: [machine] });
  assert.ok(result.ok);
  const output = machineLines(result.machines, 0, 120, 5).join("\n");
  assert.ok(!output.includes("test-secret-token-xyz"));
  assert.ok(!output.includes("botToken"));
});

test("readMachinesSection absent, unreadable, invalid JSON and invalid machines are safe", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-machines-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.json");
  assert.deepEqual(readMachinesSection(file), { ok: true, machines: [] });
  assert.deepEqual(readMachinesSection(dir), {
    ok: false,
    reason: "config.json 讀不到",
  });
  for (const content of [
    '{"botToken":"test-secret-token-xyz",',
    JSON.stringify({
      machines: [{ ...machine, id: "test-secret-token-xyz!" }],
    }),
    JSON.stringify({ machines: {} }),
    // 根節點不是物件：null、陣列、純量都要回報格式錯誤，不可當成未設定。
    "null",
    "[]",
    '"test-secret-token-xyz"',
    "42",
    // machines 含非物件項目：不可被靜默略過。
    JSON.stringify({ machines: [null] }),
    JSON.stringify({ machines: [machine, 1] }),
    JSON.stringify({ machines: ["test-secret-token-xyz"] }),
    JSON.stringify({ machines: [[machine]] }),
  ]) {
    fs.writeFileSync(file, content);
    const result = readMachinesSection(file);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(!result.reason.includes("test-secret-token-xyz"));
      assert.ok(!result.reason.includes("botToken"));
      assert.ok(!result.reason.includes("\n"));
    }
  }
});

test("readMachinesSection: object root without machines is empty, not an error", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-machines-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify({ discord: { botToken: "test-secret-token-xyz" } }));
  assert.deepEqual(readMachinesSection(file), { ok: true, machines: [] });
});

test("machineLines neutralises control characters in ssh and socket", () => {
  // JSON 跳脫的 ESC／CSI、C1、DEL、BEL 都不可原樣寫到終端。
  const hostile = {
    id: "remote",
    ssh: "user@host\u001b[2J\u001b[H\u0007",
    socket: "/tmp/\u009b2Jherdr\u007f.sock",
  };
  const [line] = machineLines([hostile], 0, 200, 3);
  assert.ok(line);
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(line));
  assert.equal(
    line,
    "> remote  user@host\uFFFD[2J\uFFFD[H\uFFFD  /tmp/\uFFFD2Jherdr\uFFFD.sock",
  );
  assert.equal(sanitizeForTerminal("plain user@host /a/b"), "plain user@host /a/b");
  assert.equal(sanitizeForTerminal("中文\t\n"), "中文\uFFFD\uFFFD");
});
