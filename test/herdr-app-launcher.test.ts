import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function run(platform: string, ready: boolean, queryFails = false) {
  const root = mkdtempSync(join(tmpdir(), "herdr-app-launch-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const script = (name: string, body: string) => writeFileSync(join(bin, name), "#!/bin/bash\n" + body, { mode: 0o700 });
  script("flock", "exit 0");
  script("uname", `echo '${platform}'`);
  script("xprop", queryFails ? "exit 1" : 'if [[ -f "$XDG_RUNTIME_DIR/ready" ]]; then echo "XIM_SERVERS(ATOM) = @server=ibus-herdr, @server=ibus"; else echo "XIM_SERVERS(ATOM) = @server=ibus-herdr-other, @server=ibus"; fi');
  script("locale", '[[ "$LC_ALL" == en_US.UTF-8 ]] || exit 1; echo UTF-8');
  script("ibus-x11", 'printf "%s|%s\\n" "$LC_ALL" "$*" >> "$XDG_RUNTIME_DIR/starts"; touch "$XDG_RUNTIME_DIR/ready"');
  script("herdr-app", 'printf "%s|%s\\n" "${XMODIFIERS:-}" "$*" > "$XDG_RUNTIME_DIR/app"');
  if (ready) writeFileSync(join(root, "ready"), "");
  try {
    const result = spawnSync("bash", [resolve("scripts/run-herdr-app.sh"), "argument with spaces"], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_RUNTIME_DIR: root, DISPLAY: ":fixture", XDG_SESSION_TYPE: "x11", XMODIFIERS: "@im=ibus" },
      encoding: "utf8", timeout: 10000,
    });
    const read = (file: string) => { try { return readFileSync(join(root, file), "utf8"); } catch { return ""; } };
    return { result, starts: read("starts"), app: read("app") };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("Linux reuses an already registered dedicated XIM and preserves literal arguments", () => {
  const f = run("Linux", true);
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.equal(f.starts, "");
  assert.equal(f.app, "@im=ibus-herdr|argument with spaces\n");
});
test("Linux starts only its dedicated XIM with English UTF-8 and waits for registration", () => {
  const f = run("Linux", false);
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.equal(f.starts, "en_US.UTF-8|--server-name=ibus-herdr\n");
  assert.equal(f.app, "@im=ibus-herdr|argument with spaces\n");
});
test("macOS bypasses the X11 workaround", () => {
  const f = run("Darwin", false);
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.equal(f.starts, "");
  assert.equal(f.app, "@im=ibus|argument with spaces\n");
});
test("unreadable X11 registration fails without starting XIM or Desktop", () => {
  const f = run("Linux", false, true);
  assert.equal(f.result.status, 1);
  assert.equal(f.starts, "");
  assert.equal(f.app, "");
});
