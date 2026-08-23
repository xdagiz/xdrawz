import { describe, expect, it } from "vite-plus/test";

import { fuzzyScore, rankEntries } from "./fuzzy-rank";

type Item = { name: string; mtimeMs: number };

const RECENCY_DAY_MS = 24 * 60 * 60 * 1000;

const entry = (name: string, mtimeMs: number): Item => ({ name, mtimeMs });

const byName = (item: Item) => item.name;

const byMtime = (item: Item) => item.mtimeMs;

describe("fuzzyScore", () => {
  it("returns the no-match sentinel when the query is not a subsequence", () => {
    expect(fuzzyScore("z", "drawing")).toBe(-1);
    expect(fuzzyScore("az", "abc")).toBe(-1);
  });

  it("scores a clean prefix as prefix bonus plus word start plus one run", () => {
    expect(fuzzyScore("ab", "abc")).toBe(10 + 6 + 4);
  });

  it("ranks a prefix match above the same letters found infix", () => {
    expect(fuzzyScore("ab", "xabc")).toBe(4);
    expect(fuzzyScore("ab", "abc")).toBeGreaterThan(fuzzyScore("ab", "xabc"));
  });

  it("ranks adjacent letters above scattered ones at the same anchor", () => {
    expect(fuzzyScore("ab", "axb")).toBe(6);
    expect(fuzzyScore("ab", "abc")).toBeGreaterThan(fuzzyScore("ab", "axb"));
  });

  it("awards a word-start bonus after separators and ignores case", () => {
    expect(fuzzyScore("s", "my-sketch")).toBe(6);
    expect(fuzzyScore("ms", "my-sketch")).toBe(6 + 6);
    expect(fuzzyScore("MS", "MY-SKETCH")).toBe(fuzzyScore("ms", "my-sketch"));
  });

  it("scores the empty query as a neutral zero", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });
});

describe("rankEntries", () => {
  it("returns nothing when nothing matches", () => {
    const items = [entry("tree", 1), entry("leaf", 2)];
    expect(rankEntries("zzz", items, byName, byMtime)).toEqual([]);
  });

  it("breaks score ties with recency so newer items win", () => {
    const stale = entry("alpha-one", 0);
    const fresh = entry("alpha-two", 10 * RECENCY_DAY_MS);
    expect(rankEntries("alpha", [stale, fresh], byName, byMtime)).toEqual([fresh, stale]);
  });

  it("returns every item in recency order for an empty query without capping", () => {
    const items = [entry("c-old", 1), entry("a-new", 3), entry("b-mid", 2)];
    const ranked = rankEntries("", items, byName, byMtime);
    expect(ranked.map((item) => item.name)).toEqual(["a-new", "b-mid", "c-old"]);
    expect(ranked).toHaveLength(items.length);
  });
});
