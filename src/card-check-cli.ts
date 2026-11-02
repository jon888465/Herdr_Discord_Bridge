#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { formatByteLimit } from "./card.js";
import { runCardCheck } from "./card-check.js";

// 先看大小再讀，避免把超大檔案整個讀進記憶體；上限由 runCardCheck 依模式傳入。
function readCardFile(path: string, maxBytes: number): string {
  const size = statSync(path).size;
  if (size > maxBytes)
    throw new Error(
      `file exceeds ${formatByteLimit(maxBytes)} (${size} bytes)`,
    );
  return readFileSync(path, "utf8");
}

const result = runCardCheck(process.argv.slice(2), readCardFile);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.code);
