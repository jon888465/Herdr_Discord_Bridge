import assert from "node:assert/strict";
import test from "node:test";
import {
  MACHINE_CONTROL_NO_SELECTION,
  MACHINE_CONTROL_PENDING,
  MACHINE_HINT,
  STATUS_OVERRIDE_MS,
  machineControlKey,
  machineControlResult,
  machineViewLines,
  withStatusOverrides,
  type MachineControlUi,
} from "../src/card-board-machines.js";
import { boardKeyAction, truncateToWidth } from "../src/card-board.js";
import type { MachineStatus } from "../src/machine-status-file.js";

const idle: MachineControlUi = { pending: false };
const needsForce = {
  ok: false as const,
  reason: "有進行中的工作：task-1，再按一次強制斷線",
  needsForce: true as const,
};

test("Machine 檢視 o／x 送出請求並進入處理中", () => {
  const o = machineControlKey(idle, "o", "machines", "m1");
  assert.deepEqual(o, {
    ui: { pending: true },
    outcome: {
      kind: "send",
      command: { action: "connect", machineId: "m1" },
      message: MACHINE_CONTROL_PENDING,
    },
  });
  const x = machineControlKey(idle, "x", "machines", "m1");
  assert.deepEqual(x.outcome, {
    kind: "send",
    command: { action: "disconnect", machineId: "m1" },
    message: "處理中…",
  });
});

test("處理中阻擋其他按鍵，q／Ctrl-C 仍立即離開", () => {
  const pending: MachineControlUi = { pending: true };
  for (const key of ["o", "x", "j", "k", "\t", "e", "\r", "n", "r", "\x1b[6~"])
    for (const view of ["machines", "cards"] as const)
      assert.deepEqual(machineControlKey(pending, key, view, "m1"), {
        ui: pending,
        outcome: { kind: "ignore" },
      });
  for (const key of ["q", "\x03"])
    for (const view of ["machines", "cards"] as const) {
      assert.equal(
        machineControlKey(pending, key, view, "m1").outcome.kind,
        "quit",
      );
      assert.equal(
        machineControlKey(idle, key, view, "m1").outcome.kind,
        "quit",
      );
    }
});

test("清單為空時不送請求，顯示沒有選取 machine", () => {
  for (const key of ["o", "x"])
    assert.deepEqual(
      machineControlKey(
        { pending: false, confirmFor: "m1" },
        key,
        "machines",
        undefined,
      ),
      {
        ui: { pending: false },
        outcome: { kind: "message", message: MACHINE_CONTROL_NO_SELECTION },
      },
    );
});

test("needsForce:true 後緊接著對同一台按 x 才送 force", () => {
  const result = machineControlResult("m1", needsForce, 0);
  assert.deepEqual(result.ui, { pending: false, confirmFor: "m1" });
  assert.equal(result.message, `m1：${needsForce.reason}`);
  assert.equal(result.override, undefined);
  const again = machineControlKey(result.ui, "x", "machines", "m1");
  assert.deepEqual(again.outcome, {
    kind: "send",
    command: { action: "disconnect", machineId: "m1", force: true },
    message: MACHINE_CONTROL_PENDING,
  });
  // 送出後確認就用掉：回應（成功）後再按 x 不會帶 force。
  assert.deepEqual(again.ui, { pending: true });
  const after = machineControlResult(
    "m1",
    { ok: true, status: "disconnected" },
    0,
  );
  const next = machineControlKey(after.ui, "x", "machines", "m1");
  assert.deepEqual(next.outcome.kind === "send" && next.outcome.command, {
    action: "disconnect",
    machineId: "m1",
  });
});

test("換台、其他按鍵或 o 都清除確認", () => {
  const confirm: MachineControlUi = { pending: false, confirmFor: "m1" };
  // 換台：同樣按 x，但選取的是另一台。
  const other = machineControlKey(confirm, "x", "machines", "m2");
  assert.deepEqual(other.outcome, {
    kind: "send",
    command: { action: "disconnect", machineId: "m2" },
    message: MACHINE_CONTROL_PENDING,
  });
  for (const key of ["j", "k", "\t", "m", "c", "e", "\r", "z", "\x1b[B"]) {
    const step = machineControlKey(confirm, key, "machines", "m1");
    assert.deepEqual(
      step,
      { ui: { pending: false }, outcome: { kind: "pass" } },
      key,
    );
    const next = machineControlKey(step.ui, "x", "machines", "m1");
    assert.deepEqual(
      next.outcome.kind === "send" && next.outcome.command,
      { action: "disconnect", machineId: "m1" },
      key,
    );
  }
  const o = machineControlKey(confirm, "o", "machines", "m1");
  assert.deepEqual(o.ui, { pending: true });
});

test("只依結構化 needsForce 判斷，不比對文案", () => {
  const sameText = machineControlResult(
    "m1",
    { ok: false, reason: needsForce.reason },
    0,
  );
  assert.deepEqual(sameText.ui, { pending: false });
  assert.equal(
    (
      machineControlKey(sameText.ui, "x", "machines", "m1").outcome as {
        command: object;
      }
    ).command.hasOwnProperty("force"),
    false,
  );
  // needsForce 不是 true（例如字串）也不算。
  const loose = machineControlResult(
    "m1",
    { ok: false, reason: "x", needsForce: "true" } as never,
    0,
  );
  assert.deepEqual(loose.ui, { pending: false });
});

test("成功與失敗結果的訊息，以及斷線後顯示已斷線", () => {
  const off = machineControlResult(
    "m1",
    { ok: true, status: "disconnected" },
    1000,
  );
  assert.equal(off.message, "m1：已斷線");
  assert.deepEqual(off.override, {
    status: "disconnected",
    untilMs: 1000 + STATUS_OVERRIDE_MS,
  });
  const on = machineControlResult(
    "m1",
    { ok: true, status: "connected" },
    1000,
  );
  assert.equal(on.message, "m1：已開始連線");
  assert.equal(on.override?.status, "unknown");
  const already = machineControlResult(
    "m1",
    { ok: true, status: "connected", note: "已在連線中" },
    1000,
  );
  assert.equal(already.message, "m1：已在連線中");
  assert.equal(already.override, undefined);
  const failed = machineControlResult(
    "m1",
    { ok: false, reason: "bridge 未連線" },
    0,
  );
  assert.equal(failed.message, "m1：bridge 未連線");
  // 控制字元不會原樣寫到終端。
  assert.ok(
    !machineControlResult(
      "m\x1b1",
      { ok: false, reason: "a\x1b[2Jb" },
      0,
    ).message.includes("\x1b"),
  );

  const file = new Map<string, MachineStatus>([
    ["m1", "connected"],
    ["m2", "unreachable"],
  ]);
  const overrides = new Map([
    ["m1", off.override!],
    ["m2", on.override!],
  ]);
  const shown = withStatusOverrides(file, overrides, 2000);
  assert.equal(shown.get("m1"), "disconnected");
  assert.equal(shown.has("m2"), false);
  assert.deepEqual(
    withStatusOverrides(file, overrides, 1000 + STATUS_OVERRIDE_MS),
    file,
    "過期後改看狀態檔",
  );

  const machines = [
    { id: "m1", ssh: "alias1", socket: "/s" },
    { id: "m2", ssh: "alias2", socket: "/s" },
  ];
  const lines = machineViewLines(
    { machines, statuses: shown, cursor: 0, error: "", message: off.message },
    120,
    24,
  );
  assert.ok(lines[1]!.includes("已斷線"), lines[1]);
  assert.ok(lines[2]!.includes("未知"), lines[2]);
  assert.equal(lines.at(-2), "m1：已斷線", "結果在訊息列");
});

test("提示列含 o／x 並依終端寬度截斷", () => {
  assert.match(MACHINE_HINT, /o 連線/);
  assert.match(MACHINE_HINT, /x 斷線/);
  for (const width of [20, 40, 80, 200]) {
    const lines = machineViewLines(
      { machines: [], cursor: 0, error: "", message: MACHINE_CONTROL_PENDING },
      width,
      10,
    );
    assert.equal(lines.at(-1), truncateToWidth(MACHINE_HINT, width - 1));
    assert.equal(
      lines.at(-2),
      truncateToWidth(MACHINE_CONTROL_PENDING, width - 1),
    );
  }
});

test("Card 檢視既有按鍵不受影響，k 仍是向上移動", () => {
  for (const key of ["o", "x", "k", "j", "e", "n", "r", "\r", "\t"])
    assert.deepEqual(machineControlKey(idle, key, "cards", "m1"), {
      ui: idle,
      outcome: { kind: "pass" },
    });
  assert.equal(boardKeyAction("k"), boardKeyAction("\x1b[A"));
  assert.notEqual(boardKeyAction("k"), undefined);
  // Machine 檢視的 k 也只是移動，不會送請求。
  assert.equal(
    machineControlKey(idle, "k", "machines", "m1").outcome.kind,
    "pass",
  );
});
