import { describe, expect, it } from "vitest";
import { maxSimilarity, similarity } from "../src/util/similarity";

describe("similarity", () => {
  it("is 1 for identical text, ignoring case and punctuation", () => {
    expect(similarity("Try Yollly for breakfast!", "try yollly for breakfast")).toBe(1);
  });

  it("is high for near-duplicates and low for different replies", () => {
    const base = "Overnight oats are great. Yollly can suggest recipes from your fridge.";
    expect(similarity(base, "Overnight oats are great! Yollly can suggest recipes from your fridge too.")).toBeGreaterThan(0.6);
    expect(similarity(base, "Shakshuka takes ten minutes and feeds two.")).toBeLessThan(0.2);
  });

  it("returns 0 for empty input and takes the max over a list", () => {
    expect(similarity("", "anything")).toBe(0);
    expect(maxSimilarity("hello world", ["nothing alike", "hello world"])).toBe(1);
    expect(maxSimilarity("hello world", [])).toBe(0);
  });
});
