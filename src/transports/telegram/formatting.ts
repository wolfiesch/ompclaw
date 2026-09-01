import { Lexer, Parser, Renderer, type Token, type Tokens } from "marked";

export const TELEGRAM_MAX_CHARS = 4096;
export const MARKDOWN_HEADROOM = 96;
export const PART_LABEL_RESERVE = 16;

const MARKDOWN_V2_CONTROL = /[_*[\]()~`>#+\-=|{}.!\\]/g;
const MARKED_OPTIONS = { gfm: true, breaks: true } as const;

export interface RenderedTelegramText {
  readonly wireText: string;
  readonly plainText: string;
  readonly parseMode?: "MarkdownV2";
}

export function escapeMdV2(text: string): string {
  return text.replace(MARKDOWN_V2_CONTROL, "\\$&");
}

function escapeCode(text: string): string {
  return text.replace(/[`\\]/g, "\\$&");
}

function escapeLinkTarget(target: string): string {
  return target.replace(/[)\\]/g, "\\$&");
}

function trimBlock(text: string): string {
  return text.replace(/^\n+|\n+$/g, "");
}

function plainTokenText(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      const value = token as Token & { readonly text?: string; readonly tokens?: readonly Token[] };
      if (value.tokens !== undefined) return plainTokenText(value.tokens);
      return value.text ?? "";
    })
    .join("");
}

class TelegramMarkdownRenderer extends Renderer<string, string> {
  override code({ text, lang }: Tokens.Code): string {
    const language = (lang ?? "").replace(/[^A-Za-z0-9+#_-]/g, "");
    return `\`\`\`${language}\n${escapeCode(text)}\n\`\`\`\n\n`;
  }

  override blockquote({ tokens }: Tokens.Blockquote): string {
    const body = trimBlock(this.parser.parse(tokens));
    return `${body
      .split("\n")
      .map((line) => `>${line}`)
      .join("\n")}\n\n`;
  }

  override html(token: Tokens.HTML | Tokens.Tag): string {
    const rendered = escapeMdV2(token.text);
    return token.type === "html" ? `${rendered}\n\n` : rendered;
  }

  override heading({ tokens }: Tokens.Heading): string {
    return `*${this.parser.parseInline(tokens)}*\n\n`;
  }

  override hr(): string {
    return "────────\n\n";
  }

  override list(token: Tokens.List): string {
    return `${token.items
      .map((item, index) => {
        const marker = token.ordered ? `${Number(token.start) + index}\\.` : "•";
        const body = trimBlock(
          item.tokens
            .map(
              (child, childIndex) =>
                `${childIndex > 0 && child.type === "list" ? "\n" : ""}${this.parser.parse([child])}`,
            )
            .join(""),
        );
        const [first = "", ...rest] = body.split("\n");
        return [`${marker} ${first}`, ...rest.map((line) => `  ${line}`)].join("\n");
      })
      .join("\n")}\n\n`;
  }

  override listitem(item: Tokens.ListItem): string {
    return this.parser.parse(item.tokens);
  }

  override checkbox({ checked }: Tokens.Checkbox): string {
    return checked ? "☑ " : "☐ ";
  }

  override paragraph({ tokens }: Tokens.Paragraph): string {
    return `${this.parser.parseInline(tokens)}\n\n`;
  }

  override table(token: Tokens.Table): string {
    const rows = [token.header, ...token.rows]
      .map((row) => row.map((cell) => plainTokenText(cell.tokens).replaceAll("\n", " ")).join(" | "))
      .join("\n");
    return `\`\`\`\n${escapeCode(rows)}\n\`\`\`\n\n`;
  }

  override strong({ tokens }: Tokens.Strong): string {
    return `*${this.parser.parseInline(tokens)}*`;
  }

  override em({ tokens }: Tokens.Em): string {
    return `_${this.parser.parseInline(tokens)}_`;
  }

  override codespan({ text }: Tokens.Codespan): string {
    return `\`${escapeCode(text)}\``;
  }

  override br(): string {
    return "\n";
  }

  override del({ tokens }: Tokens.Del): string {
    return `~${this.parser.parseInline(tokens)}~`;
  }

  override link({ href, tokens }: Tokens.Link): string {
    return `[${this.parser.parseInline(tokens)}](${escapeLinkTarget(href)})`;
  }

  override image({ href, text }: Tokens.Image): string {
    return `[${escapeMdV2(text || "image")}](${escapeLinkTarget(href)})`;
  }

  override text(token: Tokens.Text | Tokens.Escape): string {
    if ("tokens" in token && token.tokens) return this.parser.parseInline(token.tokens);
    return escapeMdV2(token.text);
  }
}

const renderer = new TelegramMarkdownRenderer();

function renderTokens(tokens: readonly Token[]): string {
  return trimBlock(Parser.parse([...tokens], { ...MARKED_OPTIONS, renderer }));
}

export function mdToMarkdownV2(markdown: string): string {
  return renderTokens(Lexer.lex(markdown, MARKED_OPTIONS));
}

type SplitMode = "length" | "newline";

function splitPoint(text: string, limit: number, mode: SplitMode): number {
  if (mode === "length") return limit;
  for (const separator of ["\n\n", "\n", ". ", " "]) {
    const found = text.lastIndexOf(separator, limit);
    if (found > limit / 2) return found + (separator === ". " ? 1 : 0);
  }
  return limit;
}

function rawParts(text: string, limit: number, mode: SplitMode): string[] {
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const boundary = Math.max(1, splitPoint(remaining, limit, mode));
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

interface MarkdownBlock {
  readonly wireText: string;
  readonly plainText: string;
}

function splitMarkdownToken(token: Token, limit: number): MarkdownBlock[] {
  const wireText = renderTokens([token]);
  const plainText = token.raw.trim();
  if (wireText.length <= limit) return wireText.length === 0 ? [] : [{ wireText, plainText }];

  if (token.type === "code") {
    const language = (token.lang ?? "").replace(/[^A-Za-z0-9+#_-]/g, "");
    const sourceLimit = Math.max(1, limit - language.length - 8);
    return rawParts(token.text, sourceLimit, "newline").map((part) => ({
      wireText: `\`\`\`${language}\n${escapeCode(part)}\n\`\`\``,
      plainText: part,
    }));
  }
  const headroom = Math.min(MARKDOWN_HEADROOM, Math.max(8, Math.floor(limit / 4)));
  const sourceLimit = Math.max(1, Math.floor((limit - headroom) / 2));

  return rawParts(token.raw.trim(), sourceLimit, "newline").flatMap((part) => {
    const tokens = Lexer.lex(part, MARKED_OPTIONS);
    const rendered = renderTokens(tokens);
    if (rendered.length <= limit) return rendered.length === 0 ? [] : [{ wireText: rendered, plainText: part }];
    return rawParts(part, Math.max(1, Math.floor(sourceLimit / 2)), "length").map((fallback) => ({
      wireText: escapeMdV2(fallback),
      plainText: fallback,
    }));
  });
}

function packMarkdownBlocks(blocks: readonly MarkdownBlock[], limit: number): RenderedTelegramText[] {
  const parts: RenderedTelegramText[] = [];
  let wireText = "";
  let plainText = "";
  const flush = (): void => {
    if (wireText.length === 0) return;
    parts.push({ wireText, plainText, parseMode: "MarkdownV2" });
    wireText = "";
    plainText = "";
  };
  for (const block of blocks) {
    const wireCandidate = wireText.length === 0 ? block.wireText : `${wireText}\n\n${block.wireText}`;
    if (wireCandidate.length > limit) flush();
    wireText = wireText.length === 0 ? block.wireText : `${wireText}\n\n${block.wireText}`;
    plainText = plainText.length === 0 ? block.plainText : `${plainText}\n\n${block.plainText}`;
  }
  flush();
  return parts;
}

export function renderMarkdownParts(markdown: string, limit = TELEGRAM_MAX_CHARS): readonly RenderedTelegramText[] {
  const cap = Math.max(1, limit);
  const blocks = Lexer.lex(markdown, MARKED_OPTIONS).flatMap((token) => splitMarkdownToken(token, cap));
  const unlabeled = packMarkdownBlocks(blocks, cap);
  if (unlabeled.length <= 1) return unlabeled;

  const labeledCap = Math.max(1, cap - PART_LABEL_RESERVE);
  const labeledBlocks = Lexer.lex(markdown, MARKED_OPTIONS).flatMap((token) => splitMarkdownToken(token, labeledCap));
  const parts = packMarkdownBlocks(labeledBlocks, labeledCap);
  return parts.map((part, index) => ({
    wireText: `(${index + 1}/${parts.length})\n${part.wireText}`,
    plainText: `(${index + 1}/${parts.length})\n${part.plainText}`,
    parseMode: "MarkdownV2",
  }));
}
