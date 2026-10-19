import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractAttachMarkers,
  resolveOutboundFiles,
} from "../src/outbound-attachments.js";

test("markers are stripped from text and collected", () => {
  const r = extractAttachMarkers(
    'done\n[[discord-attach: /a/b.png]]\n\n\n[[discord-attach: "/a/c d.pdf"]]\nbye',
  );
  assert.deepEqual(r.requested, ["/a/b.png", "/a/c d.pdf"]);
  assert.equal(r.text, "done\n\nbye");
});

test("only regular files inside the root are accepted", async () => {
  const base = await mkdtemp(join(tmpdir(), "bridge-out-"));
  const root = join(base, "proj");
  const outside = join(base, "secret.txt");
  try {
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, "ok.txt"), "hi");
    await writeFile(join(root, ".env"), "x=1");
    await writeFile(join(root, "empty.txt"), "");
    await writeFile(outside, "s");
    await symlink(outside, join(root, "link.txt"));
    const r = await resolveOutboundFiles(
      [
        join(root, "ok.txt"),
        join(root, "ok.txt"),
        join(root, ".env"),
        join(root, "empty.txt"),
        join(root, "link.txt"),
        outside,
        "relative.txt",
        root,
      ],
      [root],
    );
    assert.deepEqual(
      r.files.map((f) => f.name),
      ["ok.txt"],
    );
    assert.equal(r.rejected.length, 6);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
