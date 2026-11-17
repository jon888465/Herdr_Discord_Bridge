import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { stripJsonComments } from "./config.js";
import { validateMachines } from "./machines.js";

export type WriteReason = "invalid" | "conflict" | "write";
type Result<T> = { ok: true; value: T } | { ok: false; reason: WriteReason };
export interface MachinesSnapshot {
  bytes: Buffer;
  hash: string;
  mode: number;
}
const hash = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Token offsets refer to the original text, never comment-stripped text. */
function machinesRange(text: string): [number, number] {
  const tokens: { value: string; start: number; end: number }[] = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i]!)) {
      i++;
      continue;
    }
    if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i + 2);
      i = end < 0 ? text.length : end;
      continue;
    }
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new Error();
      i = end + 2;
      continue;
    }
    const start = i;
    if (text[i] === '"') {
      i++;
      let closed = false;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i++] === '"') {
          closed = true;
          break;
        }
      }
      if (!closed) throw new Error();
      tokens.push({
        value: JSON.parse(text.slice(start, i)) as string,
        start,
        end: i,
      });
    } else if ("{}[]:,".includes(text[i]!)) {
      tokens.push({ value: text[i++]!, start, end: i });
    } else {
      while (i < text.length && !/[\s{}\[\]:,\/]/.test(text[i]!)) i++;
      if (i === start) throw new Error();
      tokens.push({ value: text.slice(start, i), start, end: i });
    }
  }
  const stack: string[] = [];
  let range: [number, number] | undefined;
  for (let n = 0; n < tokens.length; n++) {
    const token = tokens[n]!;
    // Only a string key immediately followed by ':' at the root object qualifies.
    if (
      stack.length === 1 &&
      stack[0] === "{" &&
      text[token.start] === '"' &&
      token.value === "machines" &&
      tokens[n + 1]?.value === ":"
    ) {
      if (range || tokens[n + 2]?.value !== "[") throw new Error();
      const start = tokens[n + 2]!.start;
      let depth = 0;
      let end = -1;
      for (let k = n + 2; k < tokens.length; k++) {
        const t = tokens[k]!;
        if (text[t.start] === '"') continue;
        if (t.value === "[") depth++;
        if (t.value === "]" && --depth === 0) {
          end = t.end;
          break;
        }
      }
      if (end < 0) throw new Error();
      range = [start, end];
    }
    if (text[token.start] === '"') continue;
    if (token.value === "{" || token.value === "[") stack.push(token.value);
    if (token.value === "}" || token.value === "]") {
      if (stack.pop() !== (token.value === "}" ? "{" : "[")) throw new Error();
    }
  }
  if (stack.length || !range) throw new Error();
  return range;
}

export function spliceMachines(
  text: string,
  id: string,
  fields: { user?: string; host?: string; port?: number },
): Result<string> {
  try {
    const [start, end] = machinesRange(text);
    const parsed = JSON.parse(stripJsonComments(text)) as {
      machines: Record<string, unknown>[];
    };
    if (
      !Array.isArray(parsed.machines) ||
      !parsed.machines.every(
        (v) => v && typeof v === "object" && !Array.isArray(v),
      )
    )
      throw new Error();
    validateMachines(parsed.machines);
    const entry = parsed.machines.find((m) => m.id === id);
    if (!entry) throw new Error();
    const next = { ...entry };
    delete next.user;
    delete next.host;
    delete next.port;
    Object.assign(next, fields);
    validateMachines([next]);
    if (["user", "host", "port"].every((key) => entry[key] === next[key]))
      return { ok: true, value: text };
    const machines = parsed.machines.map((m) => (m === entry ? next : m));
    const existing = text.slice(start, end);
    const base = /^[\t ]*/.exec(
      text.slice(text.lastIndexOf("\n", start) + 1, start),
    )![0];
    const entryIndent = /\r?\n([\t ]+)\S/.exec(existing)?.[1];
    const indent = entryIndent?.startsWith(base)
      ? entryIndent.slice(base.length) || "  "
      : "  ";
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    const replacement = JSON.stringify(machines, null, indent).replace(
      /\n/g,
      newline + base,
    );
    const value = text.slice(0, start) + replacement + text.slice(end);
    validateMachines(
      (JSON.parse(stripJsonComments(value)) as { machines: unknown }).machines,
    );
    if (
      value.slice(0, start) !== text.slice(0, start) ||
      value.slice(start + replacement.length) !== text.slice(end)
    )
      throw new Error();
    return { ok: true, value };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

export function readMachinesSnapshot(file: string): Result<MachinesSnapshot> {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error();
    const bytes = fs.readFileSync(file);
    if (!Buffer.from(bytes.toString("utf8")).equals(bytes)) throw new Error();
    return {
      ok: true,
      value: { bytes, hash: hash(bytes), mode: fs.statSync(file).mode & 0o777 },
    };
  } catch {
    return { ok: false, reason: "write" };
  }
}

/** Compare-then-rename is not an atomic CAS against unrelated writers. */
export function saveMachinesConfig(
  file: string,
  snapshot: MachinesSnapshot,
  id: string,
  fields: { user?: string; host?: string; port?: number },
  io: Pick<typeof fs, "writeFileSync" | "renameSync"> &
    Partial<
      Pick<
        typeof fs,
        "openSync" | "writeSync" | "fchmodSync" | "fsyncSync" | "closeSync"
      >
    > = fs,
  backupName: (file: string) => string = (file) =>
    `${file}.bak-${new Date().toISOString().replace(/[-:.]/g, "")}-${process.pid}-${randomUUID().replace(/-/g, "")}`,
): Result<"saved" | "unchanged"> {
  let temp: string | undefined;
  try {
    const current = readMachinesSnapshot(file);
    if (!current.ok) return current;
    if (
      current.value.hash !== snapshot.hash ||
      current.value.mode !== snapshot.mode
    )
      return { ok: false, reason: "conflict" };
    const next = spliceMachines(snapshot.bytes.toString("utf8"), id, fields);
    if (!next.ok) return next;
    if (next.value === snapshot.bytes.toString("utf8"))
      return { ok: true, value: "unchanged" };
    const backup = backupName(file);
    let descriptor: number | undefined;
    let created = false;
    try {
      descriptor = (io.openSync ?? fs.openSync)(
        backup,
        "wx",
        snapshot.mode & 0o777,
      );
      created = true;
      let offset = 0;
      while (offset < snapshot.bytes.length) {
        const count = (io.writeSync ?? fs.writeSync)(
          descriptor,
          snapshot.bytes,
          offset,
          snapshot.bytes.length - offset,
        );
        if (count <= 0) throw new Error();
        offset += count;
      }
      (io.fchmodSync ?? fs.fchmodSync)(descriptor, snapshot.mode & 0o777);
      (io.fsyncSync ?? fs.fsyncSync)(descriptor);
      (io.closeSync ?? fs.closeSync)(descriptor);
      descriptor = undefined;
    } catch {
      if (descriptor !== undefined) {
        try {
          fs.closeSync(descriptor);
        } catch {
          /* fixed result only */
        }
      }
      if (created) {
        try {
          fs.unlinkSync(backup);
        } catch {
          /* fixed result only */
        }
      }
      return { ok: false, reason: "write" };
    }
    temp = `${file}.${randomUUID()}.tmp`;
    try {
      io.writeFileSync(temp, next.value, { flag: "wx", mode: snapshot.mode });
    } catch (error) {
      // An exclusive-create collision is not our file to remove.
      if ((error as NodeJS.ErrnoException).code === "EEXIST") temp = undefined;
      throw error;
    }
    fs.chmodSync(temp, snapshot.mode);
    const final = readMachinesSnapshot(file);
    if (
      !final.ok ||
      final.value.hash !== snapshot.hash ||
      final.value.mode !== snapshot.mode
    )
      return { ok: false, reason: "conflict" };
    io.renameSync(temp, file);
    temp = undefined;
    // Pruning is best effort after the config commit; unlink never follows links.
    try {
      const directory = path.dirname(file);
      const prefix = `${path.basename(file)}.bak-`;
      for (const name of fs.readdirSync(directory)) {
        const old = path.join(directory, name);
        if (
          name.startsWith(prefix) &&
          path.resolve(old) !== path.resolve(backup)
        ) {
          try {
            fs.unlinkSync(old);
          } catch {
            /* keep successful save */
          }
        }
      }
    } catch {
      /* keep successful save */
    }
    return { ok: true, value: "saved" };
  } catch {
    return { ok: false, reason: "write" };
  } finally {
    if (temp) {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        /* fixed result only */
      }
    }
  }
}
