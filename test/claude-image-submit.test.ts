import assert from "node:assert/strict";
import test from "node:test";
import { hasPendingImageInput } from "../src/herdr.js";

const rule = "─".repeat(40);

test("detects Claude input box still holding an image attachment", () => {
  const screen = `● old\n❯ [Image #1] earlier turn\n${rule}\n❯ [Image #1]請看圖\n${rule}\n  status`;
  assert.equal(hasPendingImageInput(screen), true);
});

test("ignores image markers in history once the input box is empty", () => {
  const screen = `❯ [Image #1] earlier turn\n● done\n${rule}\n❯\n${rule}\n  status`;
  assert.equal(hasPendingImageInput(screen), false);
});
