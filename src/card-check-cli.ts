#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { runCardCheck } from "./card-check.js";

const MAX_BYTES = 256 * 1024;

// 先看大小再讀，避免把超大檔案整個讀進記憶體；上限與卡片格式一致。
function readCardFile(path: string): string {
  const size = statSync(path).size;
  if (size > MAX_BYTES) throw new Error(`file exceeds 256 KiB (${size} bytes)`);
  return readFileSync(path, "utf8");
}

const result = runCardCheck(process.argv.slice(2), readCardFile);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.code);
