import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureCardsDirectory } from "../src/card-directory.js";

const posixOnly = { skip: process.platform === "win32" };
const temp = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), "card-directory-"));
const modeOf = (p: string): number => fs.statSync(p).mode & 0o777;

test("a missing directory is reported as absent and is not created when only reading", () => {
  const dir = path.join(temp(), "cards");
  assert.deepEqual(ensureCardsDirectory(dir, { create: false }), {
    ok: true,
    exists: false,
  });
  assert.equal(fs.existsSync(dir), false);
});

test("a missing directory is created private when writing", posixOnly, () => {
  const dir = path.join(temp(), "state", "cards");
  assert.deepEqual(ensureCardsDirectory(dir, { create: true }), {
    ok: true,
    exists: true,
  });
  assert.equal(modeOf(dir), 0o700);
  assert.deepEqual(ensureCardsDirectory(dir, { create: true }), {
    ok: true,
    exists: true,
  });
});

test("an existing private directory is accepted", posixOnly, () => {
  const dir = path.join(temp(), "cards");
  fs.mkdirSync(dir, { mode: 0o700 });
  assert.deepEqual(ensureCardsDirectory(dir, { create: false }), {
    ok: true,
    exists: true,
  });
});

test(
  "a directory readable by group or others is refused with the chmod command, and left unchanged",
  posixOnly,
  () => {
    for (const mode of [0o755, 0o750, 0o705, 0o770]) {
      const dir = path.join(temp(), "cards");
      fs.mkdirSync(dir);
      fs.chmodSync(dir, mode);
      const result = ensureCardsDirectory(dir, { create: true });
      assert.equal(result.ok, false, mode.toString(8));
      if (!result.ok) {
        assert.ok(result.error.includes(`chmod 700 ${dir}`), result.error);
        assert.ok(result.error.includes(mode.toString(8)), result.error);
      }
      assert.equal(modeOf(dir), mode, "the directory must not be modified");
    }
  },
);

test(
  "a symbolic link or a regular file where the directory should be is refused",
  posixOnly,
  () => {
    const base = temp();
    const real = path.join(base, "real");
    fs.mkdirSync(real, { mode: 0o700 });
    const link = path.join(base, "link");
    fs.symlinkSync(real, link);
    const viaLink = ensureCardsDirectory(link, { create: true });
    assert.equal(viaLink.ok, false);
    if (!viaLink.ok) assert.match(viaLink.error, /symbolic link/);

    const file = path.join(base, "file");
    fs.writeFileSync(file, "x");
    const onFile = ensureCardsDirectory(file, { create: true });
    assert.equal(onFile.ok, false);
    if (!onFile.ok) assert.match(onFile.error, /not a directory/);
  },
);
