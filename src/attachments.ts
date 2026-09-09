import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

export interface ImageAttachment {
  url: string;
  size: number;
  contentType?: string | null;
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
  const ext = (
    { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as Record<
      string,
      string
    >
  )[a.contentType || ""];
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
  const extensions = images.map(validateImage);
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
      const ext = extensions[i];
      const valid =
        ext === "png"
          ? bytes
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : ext === "jpg"
            ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
            : bytes.toString("ascii", 0, 4) === "RIFF" &&
              bytes.toString("ascii", 8, 12) === "WEBP";
      if (!valid)
        throw new Error("Image content does not match its declared format");
      const path = join(dir, `${i + 1}.${ext}`);
      await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
      paths.push(path);
    }
    return paths;
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
