import { describe, it, expect } from "bun:test";
import { unifiedDiff } from "../src/diff.ts";

describe("unifiedDiff", () => {
  it("returns empty string when inputs are identical", () => {
    expect(unifiedDiff("foo\nbar\n", "foo\nbar\n", "file.yaml")).toBe("");
  });

  it("emits a diff header and per-line markers when content differs", () => {
    const before = "foo\nbar\nbaz\n";
    const after = "foo\nBAR\nbaz\n";
    const out = unifiedDiff(before, after, "x.yaml");
    expect(out).toContain("--- x.yaml (on disk)");
    expect(out).toContain("+++ x.yaml (proposed)");
    expect(out).toContain("-bar");
    expect(out).toContain("+BAR");
  });

  it("handles added lines", () => {
    const out = unifiedDiff("a\n", "a\nb\n", "f.yaml");
    expect(out).toContain("+b");
  });

  it("handles removed lines", () => {
    const out = unifiedDiff("a\nb\n", "a\n", "f.yaml");
    expect(out).toContain("-b");
  });
});
