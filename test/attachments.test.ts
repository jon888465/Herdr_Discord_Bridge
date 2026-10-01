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
test("cross-format image content normalizes extension and saves successfully", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-image-cross-format-"));
  const jpegBytes = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]);
  const webpBytes = Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.alloc(4),
    Buffer.from("WEBP"),
  ]);
  const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  try {
    // 1. Declared image/png, but actually JPEG bytes -> saved as .jpg
    const paths1 = await prepareImages(
      [{ ...image, contentType: "image/png" }],
      dir,
      (async () => new Response(jpegBytes)) as typeof fetch,
    );
    assert.equal(paths1.length, 1);
    assert.match(paths1[0], /1\.jpg$/);
    assert.deepEqual(await readFile(paths1[0]), jpegBytes);

    // 2. Declared image/jpeg, but actually PNG bytes -> saved as .png
    const paths2 = await prepareImages(
      [{ ...image, contentType: "image/jpeg" }],
      dir,
      (async () => new Response(pngBytes)) as typeof fetch,
    );
    assert.equal(paths2.length, 1);
    assert.match(paths2[0], /1\.png$/);
    assert.deepEqual(await readFile(paths2[0]), pngBytes);

    // 3. Declared image/png, but actually WebP bytes -> saved as .webp
    const paths3 = await prepareImages(
      [{ ...image, contentType: "image/png; charset=utf-8" }],
      dir,
      (async () => new Response(webpBytes)) as typeof fetch,
    );
    assert.equal(paths3.length, 1);
    assert.match(paths3[0], /1\.webp$/);
    assert.deepEqual(await readFile(paths3[0]), webpBytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
