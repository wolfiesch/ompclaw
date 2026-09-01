import { describe, expect, test } from "bun:test";
import {
  PART_LABEL_RESERVE,
  TELEGRAM_MAX_CHARS,
  chunk,
  chunkLabeled,
  escapeMdV2,
  mdToMarkdownV2,
  renderMarkdownParts,
} from "./formatting";

describe("Telegram MarkdownV2 rendering", () => {
  test("escapes every Telegram control character in ordinary text", () => {
    const controls = "_ * [ ] ( ) ~ ` > # + - = | { } . ! \\";
    expect(escapeMdV2(controls)).toBe("\\_ \\* \\[ \\] \\( \\) \\~ \\` \\> \\# \\+ \\- \\= \\| \\{ \\} \\. \\! \\\\");
  });

  test("preserves supported emphasis, links, inline code, headings, and fenced code", () => {
    const source = [
      "## Build result",
      "**strong** and *quiet* with `x = 1`",
      "[artifact](https://example.com/a-b)",
      "```ts",
      "const pattern = /`/;",
      "```",
    ].join("\n");
    const rendered = mdToMarkdownV2(source);
    expect(rendered).toContain("*Build result*");
    expect(rendered).toContain("*strong* and _quiet_ with `x = 1`");
    expect(rendered).toContain("[artifact](https://example.com/a-b)");
    expect(rendered).toContain("```ts\nconst pattern = /\\`/;\n```");
  });

  test("closes an unterminated source fence", () => {
    expect(mdToMarkdownV2("```sh\necho ok")).toBe("```sh\necho ok\n```");
  });

  test("renders nested lists, task items, quotes, and tables as Telegram-safe Markdown", () => {
    const rendered = mdToMarkdownV2(
      [
        "- outer",
        "  - **inner**",
        "- [x] shipped",
        "",
        "> quoted _note_",
        "",
        "| A | B |",
        "| - | - |",
        "| 1 | `x` |",
      ].join("\n"),
    );

    expect(rendered).toContain("• outer");
    expect(rendered).toContain("• *inner*");
    expect(rendered).toContain("• ☑ shipped");
    expect(rendered).not.toContain(">*quoted*");
    expect(rendered).toContain(">quoted _note_");
    expect(rendered).toContain("```\nA | B\n1 | x\n```");
  });

  test("escapes unsafe HTML and punctuation without disturbing supported spans", () => {
    expect(mdToMarkdownV2("<script>alert(1)</script>\n\nprice = 1.0!")).toBe(
      "<script\\>alert\\(1\\)</script\\>\n\nprice \\= 1\\.0\\!",
    );
  });
});

describe("block-aware Markdown rendering", () => {
  test("keeps short Markdown blocks intact and labels multipart replies", () => {
    const source = ["## First", "alpha paragraph", "", "## Second", "beta paragraph"].join("\n");
    const parts = renderMarkdownParts(source, 40);

    expect(parts).toHaveLength(2);
    expect(parts[0]?.wireText).toStartWith("(1/2)\n*First*");
    expect(parts[0]?.plainText).toContain("## First");
    expect(parts[1]?.wireText).toStartWith("(2/2)\n*Second*");
    expect(parts.every((part) => part.wireText.length <= 40)).toBe(true);
  });

  test("splits oversized code blocks into independently valid fenced messages", () => {
    const parts = renderMarkdownParts(`\`\`\`ts\n${"const x = 1;\n".repeat(20)}\`\`\``, 90);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => (part.wireText.match(/```/g) ?? []).length === 2)).toBe(true);
    expect(parts.every((part) => part.wireText.length <= 90)).toBe(true);
  });
});

describe("message chunking", () => {
  test("honors Telegram's real maximum", () => {
    const payload = "x".repeat(TELEGRAM_MAX_CHARS + 1);
    const parts = chunk(payload, TELEGRAM_MAX_CHARS, "length");
    expect(parts.map((part) => part.length)).toEqual([TELEGRAM_MAX_CHARS, 1]);
    expect(parts.join("")).toBe(payload);
  });

  test("prefers a readable boundary when requested", () => {
    const parts = chunk("alpha beta gamma", 11, "newline");
    expect(parts).toEqual(["alpha beta", " gamma"]);
  });

  test("closes and reopens code fences across message boundaries", () => {
    const parts = chunk("```\nabcdefghij\n```", 10, "length");
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect((part.match(/```/g) ?? []).length % 2).toBe(0);
  });

  test("labels multipart replies while keeping every part under the cap", () => {
    const cap = 50;
    const parts = chunkLabeled("word ".repeat(30), cap, "newline", 2);
    expect(parts[0]).toStartWith("(3/");
    expect(parts.every((part) => part.length <= cap + PART_LABEL_RESERVE)).toBe(true);
  });
});
