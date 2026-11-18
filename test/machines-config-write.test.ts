import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readMachinesSnapshot,
  saveMachinesConfig,
  spliceMachines,
} from "../src/machines-config-write.js";

const prefix =
  '{\r\n\t"token": "FAKE_TOKEN", // machines [ ]\r\n\t"nested": {"machines": []},\r\n\t"text": "brackets [ ] and \\"machines\\" /* */",\r\n\t/* comment */ "machines": ';
const array =
  '[\r\n\t\t{"id":"remote","ssh":"alias","socket":"/r.sock","unknown":{"brackets":"]","quote":"\\\""}},\r\n\t\t{"id":"other","ssh":"other","socket":"/s.sock","future":true},\r\n\t]';
const suffix = ',\r\n\t"after": "unchanged",\r\n}\r\n';
const original = prefix + array + suffix;
const fields = { user: "alice", host: "example.com", port: 2222 };
function fixture(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "machines-write-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, original, { mode: 0o600 });
  const snapshot = readMachinesSnapshot(file);
  assert.ok(snapshot.ok);
  return { dir, file, snapshot: snapshot.value };
}

test("JSONC splice preserves prefix/suffix bytes, unknown entries and alias no-op", () => {
  assert.deepEqual(spliceMachines(original, "remote", {}), {
    ok: true,
    value: original,
  });
  const next = spliceMachines(original, "remote", fields);
  assert.ok(next.ok);
  assert.ok(
    Buffer.from(next.value)
      .subarray(0, Buffer.byteLength(prefix))
      .equals(Buffer.from(prefix)),
  );
  assert.ok(next.value.endsWith(suffix));
  assert.ok(next.value.includes('"future": true'));
  assert.ok(next.value.includes('"unknown"'));
  assert.ok(next.value.includes("\r\n\t\t{"));
  const escaped = original.replace('"machines": [', '"mach\\u0069nes": [');
  assert.equal(spliceMachines(escaped, "remote", fields).ok, true);
});

test("invalid ranges, JSON and proposed entries refuse with fixed reason", () => {
  for (const text of [
    "{}",
    '{"nested":{"machines":[]}}',
    '{"machines":{}}',
    '{"machines":null}',
    '{"machines":[],"mach\\u0069nes":[]}',
    '{"machines":[',
    '{"machines":[] /*',
    '{"machines":["unterminated]}',
    '{"machines":[],"token":"FAKE_TOKEN",bad}',
  ]) {
    const result = spliceMachines(text, "remote", fields);
    assert.equal(result.ok, false, text);
    assert.ok(!JSON.stringify(result).includes("FAKE_TOKEN"));
  }
  assert.equal(spliceMachines(original, "remote", { port: 0 }).ok, false);
  assert.equal(
    spliceMachines(
      '{"machines":[{"id":"remote","host":"host","socket":"/r"}]}',
      "remote",
      {},
    ).ok,
    false,
  );
});

test("save preserves mode and exact backup; alias round trip writes nothing", (t) => {
  const { file, snapshot } = fixture(t);
  assert.deepEqual(saveMachinesConfig(file, snapshot, "remote", {}), {
    ok: true,
    value: "unchanged",
  });
  const backup = file + ".bak-test";
  assert.equal(fs.existsSync(backup), false);
  assert.deepEqual(
    saveMachinesConfig(file, snapshot, "remote", fields, fs, () => backup),
    {
      ok: true,
      value: "saved",
    },
  );
  assert.deepEqual(fs.readFileSync(backup), snapshot.bytes);
  for (const name of [file, backup])
    assert.equal(fs.statSync(name).mode & 0o777, 0o600);
});

for (const failure of ["backup", "temp", "rename"] as const) {
  test(`${failure} failure leaves original bytes/mode and removes temp`, (t) => {
    const { dir, file, snapshot } = fixture(t);
    const result = saveMachinesConfig(file, snapshot, "remote", fields, {
      writeFileSync: ((
        name: fs.PathOrFileDescriptor,
        data: string | NodeJS.ArrayBufferView,
        options: fs.WriteFileOptions,
      ) => {
        fs.writeFileSync(name, data, options);
        if (failure === "temp" && String(name).endsWith(".tmp"))
          throw new Error("FAKE_TOKEN");
      }) as typeof fs.writeFileSync,
      writeSync: ((
        fd: number,
        data: Buffer,
        offset: number,
        length: number,
      ) => {
        if (failure === "backup") {
          fs.writeSync(fd, data, offset, Math.min(5, length));
          throw new Error("FAKE_TOKEN");
        }
        return fs.writeSync(fd, data, offset, length);
      }) as typeof fs.writeSync,
      renameSync: (a, b) => {
        if (failure === "rename") throw new Error("FAKE_TOKEN");
        fs.renameSync(a, b);
      },
    });
    assert.deepEqual(result, { ok: false, reason: "write" });
    assert.deepEqual(fs.readFileSync(file), snapshot.bytes);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(!fs.readdirSync(dir).some((name) => name.endsWith(".tmp")));
    if (failure === "backup")
      assert.ok(
        !fs
          .readdirSync(dir)
          .some((name) => name.startsWith("config.json.bak-")),
      );
  });
}

test("editor and final recheck detect unrelated concurrent writes", (t) => {
  const { dir, file, snapshot } = fixture(t);
  const external = original.replace("FAKE_TOKEN", "CHANGED_TOKEN");
  fs.writeFileSync(file, external);
  assert.deepEqual(saveMachinesConfig(file, snapshot, "remote", fields), {
    ok: false,
    reason: "conflict",
  });
  fs.writeFileSync(file, original);
  const result = saveMachinesConfig(file, snapshot, "remote", fields, {
    writeFileSync: ((
      name: fs.PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
      options: fs.WriteFileOptions,
    ) => {
      fs.writeFileSync(name, data, options);
      if (String(name).endsWith(".tmp")) fs.writeFileSync(file, external);
    }) as typeof fs.writeFileSync,
    renameSync: () => assert.fail("rename must not run"),
  });
  assert.deepEqual(result, { ok: false, reason: "conflict" });
  assert.equal(fs.readFileSync(file, "utf8"), external);
  assert.ok(!fs.readdirSync(dir).some((name) => name.endsWith(".tmp")));
});

for (const collision of ["symlink", "file"] as const) {
  test(`exclusive backup refuses ${collision} introduced immediately before open`, (t) => {
    const { dir, file, snapshot } = fixture(t);
    const backup = file + ".bak-predictable";
    const target = path.join(dir, "untouched");
    fs.writeFileSync(target, "UNCHANGED", { mode: 0o600 });
    const result = saveMachinesConfig(
      file,
      snapshot,
      "remote",
      fields,
      {
        ...fs,
        openSync: ((name: fs.PathLike, flags: string, mode: number) => {
          assert.equal(String(name), backup);
          assert.equal(flags, "wx");
          if (collision === "symlink") fs.symlinkSync(target, backup);
          else fs.writeFileSync(backup, "COLLISION");
          return fs.openSync(name, flags, mode);
        }) as typeof fs.openSync,
      },
      () => backup,
    );
    assert.deepEqual(result, { ok: false, reason: "write" }); // backup-race assertion
    assert.deepEqual(fs.readFileSync(file), snapshot.bytes);
    assert.equal(fs.statSync(file).mode & 0o777, snapshot.mode);
    assert.equal(fs.readFileSync(target, "utf8"), "UNCHANGED");
    assert.ok(!fs.readdirSync(dir).some((name) => name.endsWith(".tmp")));
    assert.equal(
      fs.readFileSync(backup, "utf8"),
      collision === "symlink" ? "UNCHANGED" : "COLLISION",
    );
  });
}

test("descriptor backup loops on short writes and prunes only older backup names", (t) => {
  const { dir, file, snapshot } = fixture(t);
  fs.writeFileSync(file + ".bak-old", "old");
  const target = path.join(dir, "untouched");
  fs.writeFileSync(target, "UNCHANGED");
  fs.symlinkSync(target, file + ".bak-link");
  fs.writeFileSync(file + ".bak", "legacy");
  const backup = file + ".bak-new";
  let writes = 0;
  const result = saveMachinesConfig(
    file,
    snapshot,
    "remote",
    fields,
    {
      ...fs,
      writeSync: ((
        fd: number,
        data: Buffer,
        offset: number,
        length: number,
      ) => {
        writes++;
        return fs.writeSync(fd, data, offset, Math.min(7, length));
      }) as typeof fs.writeSync,
    },
    () => backup,
  );
  assert.deepEqual(result, { ok: true, value: "saved" });
  assert.ok(writes > 1);
  assert.deepEqual(fs.readFileSync(backup), snapshot.bytes);
  assert.equal(fs.statSync(backup).mode & 0o777, snapshot.mode);
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.startsWith("config.json.bak-")),
    ["config.json.bak-new"],
  );
  assert.equal(fs.readFileSync(target, "utf8"), "UNCHANGED");
  assert.equal(fs.readFileSync(file + ".bak", "utf8"), "legacy");
});

test("ssh alias 的 machine 可以只改 port；沒有 ssh 的 machine 只給 port 會被擋下（ISSUE-168）", () => {
  const next = spliceMachines(original, "remote", { port: 50123 });
  assert.ok(next.ok);
  assert.ok(next.value.includes('"port": 50123'));
  assert.ok(!next.value.includes('"host"'));
  const hostOnly = '{"machines":[{"id":"h","host":"example.com","socket":"/s"}]}';
  assert.deepEqual(spliceMachines(hostOnly, "h", { port: 50123 }), { ok: false, reason: "invalid" });
});
