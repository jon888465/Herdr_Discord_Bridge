/** Keep code fences balanced in each Discord message. Original text is not summarized. */
export function splitFinalMarkdown(text: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  let fence = "";
  let marker = "";
  const flush = () => {
    if (!chunk.trim()) return;
    chunks.push(chunk + (fence ? `\n${marker}` : ""));
    chunk = fence ? `${fence}\n` : "";
  };
  for (const line of text.split(/(?<=\n)/)) {
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})([^\n]*)/);
    if (match && match[0].length < 100) {
      if (chunk.length + line.length > 1750) flush();
      chunk += line;
      if (!fence) {
        fence = line.trimEnd();
        marker = match[1];
      } else if (
        match[1][0] === marker[0] &&
        match[1].length >= marker.length &&
        !match[2].trim()
      ) {
        fence = "";
        marker = "";
      }
      continue;
    }
    if (line.length <= 1650 && chunk.length + line.length > 1750) flush();
    let rest = line;
    while (rest) {
      let available = 1750 - chunk.length;
      if (available <= 0) {
        flush();
        available = 1750 - chunk.length;
      }
      let cut = Math.min(rest.length, available);
      // Do not split a UTF-16 surrogate pair.
      if (cut < rest.length && /[\uD800-\uDBFF]/.test(rest[cut - 1])) cut--;
      if (!cut) {
        flush();
        continue;
      }
      chunk += rest.slice(0, cut);
      rest = rest.slice(cut);
      if (rest) flush();
    }
  }
  flush();
  return chunks;
}
