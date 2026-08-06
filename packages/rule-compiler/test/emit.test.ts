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

  // The engine's real rule is not "at most one range" — once it has read a
  // range's high character the next character must be `]`. So a single range
  // with ANYTHING beside it is the same fatal parse error as two ranges.
  it("expands a single range followed by a literal", () => {
    expect(stignoreBody(["[a-z_]"])).toEqual(["[abcdefghijklmnopqrstuvwxyz_]"]);
    expect(stignoreBody(["[0-9.]"])).toEqual(["[0123456789.]"]);
  });

  it("expands a literal followed by a range, which the engine misreads", () => {
    // gobwas would otherwise read this as the four literals `_ a - z`.
    expect(stignoreBody(["[_a-z]"])).toEqual(["[_abcdefghijklmnopqrstuvwxyz]"]);
  });

  it("moves a trailing hyphen out of range position", () => {
    // `[a-z-]` is fatal as authored; the rewrite must not re-create `c-x`.
    expect(stignoreBody(["[a-z-]"])).toEqual(["[abcdefghijklmnopqrstuvwxyz-]"]);
    expect(stignoreBody(["[a-c-x0-9]"])).toEqual(["[abcx0123456789-]"]);
  });

  it("refuses to expand a span containing ] or backslash", () => {
    // 0x41-0x5F crosses `]` and `\`. Emitting them as literals would close the
    // class early — turning an over-wide pattern into a whole-file rejection.
    //
    // Passthrough is NOT "handled": the pattern is still fatal to Syncthing.
    // Emitting stays a pure string operation, and compile() is what refuses to
    // ship it — see "refuses to emit a bracket class Syncthing cannot parse"
    // in compile.test.ts. Keep both: this pins the emitter's purity, that one
    // pins that the poison never reaches an artifact.
    expect(stignoreBody(["[A-_a-z]"])).toEqual(["[A-_a-z]"]);
  });

  it("leaves a class with no range alone even when it holds many chars", () => {
    expect(stignoreBody(["[Cc][Oo][Dd][Ee]"])).toEqual(["[Cc][Oo][Dd][Ee]"]);
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
