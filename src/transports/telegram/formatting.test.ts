import { describe, expect, test } from "bun:test";
import {
  PART_LABEL_RESERVE,
  TELEGRAM_MAX_CHARS,
  chunk,
  chunkLabeled,
  escapeMdV2,
  mdToMarkdownV2,
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
