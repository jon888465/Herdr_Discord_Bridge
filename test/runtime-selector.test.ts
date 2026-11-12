import test from "node:test";
import assert from "node:assert/strict";
import { resolveRuntimeKind } from "../src/runtime/select.js";
import { RuntimeError } from "../src/runtime/errors.js";
import { resolveCoreSocketPath } from "../src/runtime/core-adapter.js";

test("runtime 預設使用 Herdr，config 可選 Core，env 優先", () => {
  assert.equal(resolveRuntimeKind({ env: {}, config: {} }), "herdr");
  assert.equal(
    resolveRuntimeKind({ env: {}, config: { runtime: "core" } }),
    "core",
  );
  assert.equal(
    resolveRuntimeKind({
      env: { HERDR_BRIDGE_RUNTIME: "herdr" },
      config: { runtime: "core" },
    }),
    "herdr",
  );
  assert.equal(
    resolveRuntimeKind({
      env: { HERDR_BRIDGE_RUNTIME: "core" },
      config: { runtime: "invalid" },
    }),
    "core",
  );
});

test("runtime 未知值與空值明確拒絕，不回退", () => {
  for (const value of ["", "CORE", "unknown", null, 1]) {
    assert.throws(
      () => resolveRuntimeKind({ env: {}, config: { runtime: value } }),
      (error: unknown) =>
        error instanceof RuntimeError && error.code === "RUNTIME_INCOMPATIBLE",
    );
  }
  assert.throws(
    () =>
      resolveRuntimeKind({
        env: { HERDR_BRIDGE_RUNTIME: "" },
        config: { runtime: "herdr" },
      }),
    RuntimeError,
  );
});

const none = () => false;

test("Core socket 只採 HC_SOCKET、HC_SESSION 與 default", () => {
  assert.equal(
    resolveCoreSocketPath(
      {
        HC_SOCKET: "/tmp/core.sock",
        HC_SESSION: "other",
        HC_TERMINAL_SOCKET: "/tmp/terminal.sock",
        XDG_RUNTIME_DIR: "/run/user/1",
        HERDR_SOCKET_PATH: "/tmp/legacy.sock",
      },
      "/home/test",
      none,
    ),
    "/tmp/core.sock",
  );
  assert.equal(
    resolveCoreSocketPath({ HC_SESSION: "other" }, "/home/test", none),
    "/home/test/.local/state/herdr-core/other/other.sock",
  );
  assert.equal(
    resolveCoreSocketPath(
      { HERDR_SOCKET_PATH: "/tmp/legacy.sock" },
      "/home/test",
      none,
    ),
    "/home/test/.local/state/herdr-core/default/default.sock",
  );
  for (const session of ["", "..", "../other", "/tmp/other"])
    assert.throws(
      () => resolveCoreSocketPath({ HC_SESSION: session }, "/home/test", none),
      RuntimeError,
    );
  assert.throws(() => resolveCoreSocketPath({ HC_SOCKET: "" }), RuntimeError);
});

test("Core socket：Linux XDG_RUNTIME_DIR 與 Core terminal 的 HC_TERMINAL_SOCKET（ISSUE-151）", () => {
  const xdg = "/run/user/1000/herdr-core/default.sock";
  const state = "/home/test/.local/state/herdr-core/default/default.sock";
  // 都不存在：取 XDG_RUNTIME_DIR 候選（Linux Core 的實際位置）。
  assert.equal(
    resolveCoreSocketPath(
      { XDG_RUNTIME_DIR: "/run/user/1000" },
      "/home/test",
      none,
    ),
    xdg,
  );
  // 只有 state 路徑存在（Core 在沒有 XDG_RUNTIME_DIR 的環境啟動）：取存在者。
  assert.equal(
    resolveCoreSocketPath(
      { XDG_RUNTIME_DIR: "/run/user/1000" },
      "/home/test",
      (file) => file === state,
    ),
    state,
  );
  assert.equal(
    resolveCoreSocketPath(
      { XDG_RUNTIME_DIR: "/run/user/1000", HC_SESSION: "work" },
      "/home/test",
      none,
    ),
    "/run/user/1000/herdr-core/work.sock",
  );
  // 空字串視為未設；相對路徑拒絕。
  assert.equal(
    resolveCoreSocketPath({ XDG_RUNTIME_DIR: "" }, "/home/test", none),
    state,
  );
  assert.throws(
    () =>
      resolveCoreSocketPath({ XDG_RUNTIME_DIR: "run/user" }, "/home/test", none),
    RuntimeError,
  );
  assert.equal(
    resolveCoreSocketPath(
      { XDG_STATE_HOME: "/var/state" },
      "/home/test",
      none,
    ),
    "/var/state/herdr-core/default/default.sock",
  );
  // Core terminal 內：未設 HC_SESSION 時採 HC_TERMINAL_SOCKET；設了 HC_SESSION 則依 session。
  assert.equal(
    resolveCoreSocketPath(
      {
        HC_TERMINAL_SOCKET: "/run/user/1000/herdr-core/default.sock",
        XDG_RUNTIME_DIR: "/run/user/1000",
      },
      "/home/test",
      none,
    ),
    "/run/user/1000/herdr-core/default.sock",
  );
  assert.equal(
    resolveCoreSocketPath(
      {
        HC_TERMINAL_SOCKET: "/run/user/1000/herdr-core/default.sock",
        HC_SESSION: "work",
      },
      "/home/test",
      none,
    ),
    "/home/test/.local/state/herdr-core/work/work.sock",
  );
  assert.throws(
    () =>
      resolveCoreSocketPath(
        { HC_TERMINAL_SOCKET: "relative.sock" },
        "/home/test",
        none,
      ),
    RuntimeError,
  );
});
