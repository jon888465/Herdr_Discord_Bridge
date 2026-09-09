import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareImages, validateImage } from "../src/attachments.js";
const image = {
  url: "https://cdn.discordapp.com/attachments/1/2/image.png",
  size: 8,
  contentType: "image/png",
};
test("reject unsafe attachment URLs and unsupported or oversize content", () => {
  for (const override of [
    { url: "http://127.0.0.1/a" },
    { url: "https://evil.test/a" },
    { contentType: "image/svg+xml" },
    { size: 6 * 1024 * 1024 },
  ])
    assert.throws(() => validateImage({ ...image, ...override }));
});
test("multiple images are saved with generated names and exact bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-image-test-"));
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const request = (async () => new Response(bytes)) as typeof fetch;
  try {
    const paths = await prepareImages([image, image], dir, request);
    assert.equal(paths.length, 2);
    assert.notEqual(paths[0], paths[1]);
    assert.deepEqual(await readFile(paths[0]), bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("download failure and invalid bytes clean up partial attachment sets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-image-failure-"));
  try {
    await assert.rejects(
      prepareImages(
        [image],
        dir,
        (async () => new Response("not png")) as typeof fetch,
      ),
      /format/,
    );
    assert.deepEqual(await readdir(dir), []);
    await assert.rejects(
      prepareImages(
        [image],
        dir,
        (async () => new Response(null, { status: 403 })) as typeof fetch,
      ),
      /download/,
    );
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
