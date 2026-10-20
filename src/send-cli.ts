#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sendRequest } from "./send-ipc.js";

const USAGE = `Usage: herdr-discord-send [--file PATH]... [--stdin] [TEXT...]
Sends text and/or files to the Discord thread mapped to this Herdr pane
(requires HERDR_PANE_ID, set by Herdr, and a running bridge).`;

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const files: string[] = [];
  const words: string[] = [];
  let stdin = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      return 0;
    }
    if (arg === "--stdin") stdin = true;
    else if (arg === "--file" || arg === "-f") {
      const value = args[++i];
      if (!value) {
        console.error("--file needs a path");
        return 2;
      }
      files.push(resolve(value));
    } else words.push(arg);
  }
  const paneId = process.env.HERDR_PANE_ID;
  if (!paneId) {
    console.error("HERDR_PANE_ID is not set; run this inside a Herdr pane.");
    return 2;
  }
  const text = [words.join(" "), stdin ? readFileSync(0, "utf8") : ""]
    .filter((part) => part.trim())
    .join("\n")
    .trim();
  if (!text && !files.length) {
    console.error(USAGE);
    return 2;
  }
  const response = await sendRequest({ paneId, text, files });
  (response.ok ? console.log : console.error)(response.message);
  return response.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : "send failed");
    process.exit(1);
  },
);
