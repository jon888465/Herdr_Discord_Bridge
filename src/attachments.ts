import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  writeFile,
  rm,
} from "node:fs/promises";
import { basename, join } from "node:path";

export interface ImageAttachment {
  url: string;
  size: number;
  contentType?: string | null;
}
export type SupportedImageExt = "png" | "jpg" | "webp";

export function detectImageFormat(bytes: Buffer): SupportedImageExt | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return "png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  ) {
    return "jpg";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

const MAX_BYTES = 5 * 1024 * 1024;
export function validateImage(a: ImageAttachment): string {
  const url = new URL(a.url);
  if (
    url.protocol !== "https:" ||
    !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  )
    throw new Error("Image URL must be a Discord HTTPS attachment URL");
  const normalizedType = (a.contentType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const ext = (
    {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/webp": "webp",
    } as Record<string, string>
  )[normalizedType];
  if (!ext)
    throw new Error("Only PNG, JPEG and WebP image attachments are supported");
  if (!Number.isFinite(a.size) || a.size <= 0 || a.size > MAX_BYTES)
    throw new Error("Each image must be at most 5 MiB");
  return ext;
}
export async function prepareImages(
  images: ImageAttachment[],
  root: string,
  request: typeof fetch = fetch,
): Promise<string[]> {
  if (images.length > 4)
    throw new Error("At most four images per message are supported");
  images.forEach(validateImage);
  if (!images.length) return [];
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(root, "message-"));
  const paths: string[] = [];
  try {
    for (const [i, a] of images.entries()) {
      const response = await request(a.url, {
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok || !response.body)
        throw new Error("Image download failed");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.length;
          if (size > MAX_BYTES) throw new Error("Image download exceeds 5 MiB");
          chunks.push(item.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const bytes = Buffer.concat(chunks);
      const actualExt = detectImageFormat(bytes);
      if (!actualExt)
        throw new Error(
          "Image content does not match a supported image format",
        );
      const path = join(dir, `${i + 1}.${actualExt}`);
      await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
      paths.push(path);
    }
    return paths;
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

export interface InboundAttachment extends ImageAttachment {
  name?: string | null;
}
export interface PreparedAttachment {
  path: string;
  kind: "image" | "file";
}

export function isSupportedImageType(contentType?: string | null): boolean {
  return IMAGE_TYPES.has(
    (contentType || "").split(";")[0].trim().toLowerCase(),
  );
}

function assertDiscordUrl(raw: string): void {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  )
    throw new Error("Attachment URL must be a Discord HTTPS attachment URL");
}

/** Keep the original name readable but never let it escape the directory. */
export function safeFileName(
  name: string | null | undefined,
  fallback: string,
): string {
  const base = basename((name || "").replace(/\\/g, "/"))
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^\.+/, "")
    .slice(0, 80);
  return base || fallback;
}

async function download(
  url: string,
  limit: number,
  request: typeof fetch,
): Promise<Buffer> {
  const response = await request(url, {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok || !response.body)
    throw new Error("Attachment download failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > limit)
        throw new Error(
          `Attachment download exceeds ${limit / 1024 / 1024} MiB`,
        );
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

/**
 * Images (PNG/JPEG/WebP) keep the strict checks above; every other Discord
 * attachment is saved as a plain file (at most 10 MiB) under a sanitized name.
 * The bridge never executes or interprets file contents.
 */
export async function prepareAttachments(
  items: InboundAttachment[],
  root: string,
  request: typeof fetch = fetch,
): Promise<PreparedAttachment[]> {
  if (items.length > 4)
    throw new Error("At most four attachments per message are supported");
  for (const item of items) {
    if (isSupportedImageType(item.contentType)) validateImage(item);
    else {
      assertDiscordUrl(item.url);
      if (
        !Number.isFinite(item.size) ||
        item.size <= 0 ||
        item.size > MAX_FILE_BYTES
      )
        throw new Error("Each file must be non-empty and at most 10 MiB");
    }
  }
  if (!items.length) return [];
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(root, "message-"));
  const prepared: PreparedAttachment[] = [];
  try {
    for (const [i, item] of items.entries()) {
      if (isSupportedImageType(item.contentType)) {
        const bytes = await download(item.url, MAX_BYTES, request);
        const ext = detectImageFormat(bytes);
        if (!ext)
          throw new Error(
            "Image content does not match a supported image format",
          );
        const path = join(dir, `${i + 1}.${ext}`);
        await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
        prepared.push({ path, kind: "image" });
      } else {
        const bytes = await download(item.url, MAX_FILE_BYTES, request);
        const path = join(dir, `${i + 1}-${safeFileName(item.name, "file")}`);
        await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
        prepared.push({ path, kind: "file" });
      }
    }
    return prepared;
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

/** 附件保留期限：超過 3 天的 message-* 目錄會被清理（ISSUE-043）。 */
export const ATTACHMENT_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

export const ATTACHMENT_SUBDIR = [".herdr-discord-bridge", "attachments"];

/**
 * 刪除 root 底下超過保留期限的 `message-*` 目錄。只處理 root 的直接子項、名稱符合
 * `message-<英數>`、為真正的目錄（不跟隨 symlink）；其他檔案一律不動。回傳刪除數量。
 */
export async function cleanupOldAttachments(
  root: string,
  maxAgeMs = ATTACHMENT_RETENTION_MS,
  now = Date.now(),
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!/^message-[A-Za-z0-9]+$/.test(name)) continue;
    const path = join(root, name);
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || now - info.mtimeMs <= maxAgeMs) continue;
      await rm(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      // 清理失敗不影響其他目錄；下一輪再試。
    }
  }
  return removed;
}
