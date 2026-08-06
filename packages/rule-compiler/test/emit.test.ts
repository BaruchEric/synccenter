import { describe, expect, it } from "bun:test";
import { emitRcloneFilter, emitStignore } from "../src/emit.ts";

const HEADER = "# GENERATED";

function stignoreBody(patterns: string[], extra: string[] = []): string[] {
  return emitStignore(patterns, extra, HEADER)
    .split("\n")
    .filter((l) => l && l !== HEADER);
}

describe("emitStignore bracket sanitising", () => {
  // These two are verbatim lines from GitHub's Vim.gitignore. Syncthing's glob
  // engine rejects a class holding two ranges, and one rejected pattern makes
  // it discard the whole ignore file — the folder then syncs with NO ignores.
  it("expands a class with two ranges into an explicit character list", () => {
    expect(stignoreBody(["[._]ss[a-gi-z]"])).toEqual(["[._]ss[abcdefgijklmnopqrstuvwxyz]"]);
  });

  it("expands only the offending class, leaving single-range classes alone", () => {
    expect(stignoreBody(["[._]s[a-rt-v][a-z]"])).toEqual(["[._]s[abcdefghijklmnopqrtuv][a-z]"]);
  });

  it("leaves a single range untouched", () => {
    expect(stignoreBody(["[._]*.sw[a-p]"])).toEqual(["[._]*.sw[a-p]"]);
  });

  it("leaves a plain character list untouched", () => {
    expect(stignoreBody(["[._]foo"])).toEqual(["[._]foo"]);
  });

  it("preserves a negated class marker", () => {
    expect(stignoreBody(["x[!a-ce-g]"])).toEqual(["x[!abcefg]"]);
  });

  it("sanitises engine_overrides extras too", () => {
    expect(stignoreBody([], ["[._]ss[a-gi-z]"])).toEqual(["[._]ss[abcdefgijklmnopqrstuvwxyz]"]);
  });

  it("still reverses pattern order for first-match-wins", () => {
    expect(stignoreBody(["*.log", "!keep.log"])).toEqual(["!keep.log", "*.log"]);
  });
});

describe("emitRcloneFilter", () => {
  // rclone accepts both forms, so it keeps the pattern as authored.
  it("does not rewrite bracket ranges", () => {
    const out = emitRcloneFilter(["[._]ss[a-gi-z]"], [], HEADER);
    expect(out).toContain("- [._]ss[a-gi-z]");
  });
});
