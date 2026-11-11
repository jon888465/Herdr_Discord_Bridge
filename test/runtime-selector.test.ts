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

test("Core socket 只採 HC_SOCKET、HC_SESSION 與 default", () => {
  assert.equal(
    resolveCoreSocketPath(
      {
        HC_SOCKET: "/tmp/core.sock",
        HC_SESSION: "other",
        HERDR_SOCKET_PATH: "/tmp/legacy.sock",
      },
      "/home/test",
    ),
    "/tmp/core.sock",
  );
  assert.equal(
    resolveCoreSocketPath({ HC_SESSION: "other" }, "/home/test"),
    "/home/test/.local/state/herdr-core/other/other.sock",
  );
  assert.equal(
    resolveCoreSocketPath(
      { HERDR_SOCKET_PATH: "/tmp/legacy.sock" },
      "/home/test",
    ),
    "/home/test/.local/state/herdr-core/default/default.sock",
  );
  for (const session of ["", "..", "../other", "/tmp/other"])
    assert.throws(
      () => resolveCoreSocketPath({ HC_SESSION: session }),
      RuntimeError,
    );
  assert.throws(() => resolveCoreSocketPath({ HC_SOCKET: "" }), RuntimeError);
});
