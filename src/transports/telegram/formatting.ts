export const TELEGRAM_MAX_CHARS = 4096;
export const MARKDOWN_HEADROOM = 96;
export const PART_LABEL_RESERVE = 16;

const MARKDOWN_V2_CONTROL = /[_*[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMdV2(text: string): string {
  return text.replace(MARKDOWN_V2_CONTROL, "\\$&");
}

function closing(source: string, marker: string, from: number): number {
  const index = source.indexOf(marker, from);
  return index < from ? -1 : index;
}

function renderInline(source: string): string {
  let cursor = 0;
  let output = "";
  const literal = (end: number): void => {
    output += escapeMdV2(source.slice(cursor, end));
    cursor = end;
  };

  while (cursor < source.length) {
    if (source[cursor] === "`") {
      const end = closing(source, "`", cursor + 1);
      if (end > cursor + 1) {
        const code = source.slice(cursor + 1, end).replace(/[`\\]/g, "\\$&");
        output += `\`${code}\``;
        cursor = end + 1;
        continue;
      }
    }
    if (source.startsWith("**", cursor)) {
      const end = closing(source, "**", cursor + 2);
      if (end > cursor + 2) {
        output += `*${escapeMdV2(source.slice(cursor + 2, end))}*`;
        cursor = end + 2;
        continue;
      }
    }
    if (source[cursor] === "*" || source[cursor] === "_") {
      const marker = source[cursor] ?? "";
      const end = closing(source, marker, cursor + 1);
      if (end > cursor + 1) {
        output += `_${escapeMdV2(source.slice(cursor + 1, end))}_`;
        cursor = end + 1;
        continue;
      }
    }
    if (source[cursor] === "[") {
      const labelEnd = closing(source, "](", cursor + 1);
      const targetEnd = labelEnd < 0 ? -1 : closing(source, ")", labelEnd + 2);
      if (labelEnd > cursor && targetEnd > labelEnd + 2) {
        const label = escapeMdV2(source.slice(cursor + 1, labelEnd));
        const target = source.slice(labelEnd + 2, targetEnd).replace(/[)\\]/g, "\\$&");
        output += `[${label}](${target})`;
        cursor = targetEnd + 1;
        continue;
      }
    }
    literal(cursor + 1);
  }
  return output;
}

export function mdToMarkdownV2(markdown: string): string {
  const output: string[] = [];
  let fenceLanguage: string | undefined;
  let code: string[] = [];

  const closeFence = (): void => {
    const language = (fenceLanguage ?? "").replace(/[^A-Za-z0-9+#_-]/g, "");
    const body = code.join("\n").replace(/[`\\]/g, "\\$&");
    output.push(`\`\`\`${language}\n${body}\n\`\`\``);
    fenceLanguage = undefined;
    code = [];
  };

  for (const line of markdown.split("\n")) {
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence !== null) {
      if (fenceLanguage === undefined) fenceLanguage = fence[1] ?? "";
      else closeFence();
      continue;
    }
    if (fenceLanguage !== undefined) {
      code.push(line);
      continue;
    }
    const heading = /^\s*#{1,6}\s+(.+?)\s*$/.exec(line);
    output.push(heading === null ? renderInline(line) : `*${escapeMdV2(heading[1] ?? "")}*`);
  }
  if (fenceLanguage !== undefined) closeFence();
  return output.join("\n");
}

type SplitMode = "length" | "newline";

function splitPoint(text: string, limit: number, mode: SplitMode): number {
  if (mode === "length") return limit;
  for (const separator of ["\n\n", "\n", " "]) {
    const found = text.lastIndexOf(separator, limit);
    if (found > limit / 2) return found;
  }
  return limit;
}

function rawParts(text: string, limit: number, mode: SplitMode): string[] {
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const boundary = splitPoint(remaining, limit, mode);
    parts.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary).replace(/^\n+/, "");
  }
  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

export function chunk(text: string, limit: number, mode: SplitMode): string[] {
  let reopenFence = false;
  return rawParts(text, Math.max(1, limit), mode).map((raw) => {
    let part = reopenFence ? `\`\`\`\n${raw}` : raw;
    reopenFence = ((part.match(/```/g) ?? []).length & 1) === 1;
    if (reopenFence) part += "\n```";
    return part;
  });
}

export function chunkLabeled(text: string, limit: number, mode: SplitMode, priorParts = 0): string[] {
  const unlabeled = chunk(text, limit, mode);
  if (unlabeled.length <= 1 && priorParts === 0) return unlabeled;
  const parts = chunk(text, Math.max(1, limit - PART_LABEL_RESERVE), mode);
  const total = priorParts + parts.length;
  return parts.map((part, index) => `(${priorParts + index + 1}/${total})\n${part}`);
}
