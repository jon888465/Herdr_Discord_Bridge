import fs from "node:fs";
import path from "node:path";

const roots = ["src", "test"];
const files = [];
function walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
}
for (const root of roots) walk(root);
const errors = [];
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  if (/\bany\b/.test(text)) errors.push(`${file}: explicit any is not allowed`);
  if (/[ \t]+\r?\n/.test(text)) errors.push(`${file}: trailing whitespace`);
  if (/DISCORD_BOT_TOKEN\s*[:=]\s*["'][^"']+["']/.test(text))
    errors.push(`${file}: possible Discord credential`);
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`lint ok (${files.length} TypeScript files)`);
