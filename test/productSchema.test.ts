import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProducts, parseProduct } from "../src/config/loadProducts";
import { llmChoiceFor } from "../src/config/productSchema";

const refs = { platforms: ["threads"], llmProviders: ["anthropic", "openai"], approvalChannels: ["telegram"] };

describe("product configs", () => {
  it("accepts the shipped Yollly config and fills defaults", async () => {
    const raw = JSON.parse(await readFile("products/yollly.json", "utf8"));
    const product = parseProduct(raw, "yollly.json", refs);
    expect(product.id).toBe("yollly");
    expect(product.replyPolicy.allowLinks).toBe(false);
    expect(llmChoiceFor(product, "draft").effort).toBe("medium");
    expect(llmChoiceFor(product, "rank")).toEqual(product.llm.default);
  });

  it("applies defaults for omitted sections", () => {
    const product = parseProduct(minimal(), "min.json", refs);
    expect(product.filters.maxDraftsPerRun).toBe(5);
    expect(product.replyPolicy.dailyCap).toBe(20);
    expect(product.discovery.searchType).toBe("RECENT");
  });

  it("rejects unknown platforms, providers and invalid fields with the file name", () => {
    expect(() => parseProduct({ ...minimal(), platform: { name: "myspace" } }, "bad.json", refs)).toThrow(/bad\.json: unknown platform/);
    expect(() =>
      parseProduct({ ...minimal(), llm: { default: { provider: "anthropic", model: "m" }, draft: { provider: "x", model: "m" } } }, "bad.json", refs),
    ).toThrow(/unknown LLM provider "x" for draft/);
    expect(() => parseProduct({ ...minimal(), id: "Has Spaces" }, "bad.json", refs)).toThrow(/bad\.json: invalid product config/);
  });

  it("loads every json file in a folder and rejects duplicate ids", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "products-"));
    await writeFile(path.join(dir, "a.json"), JSON.stringify(minimal()));
    await writeFile(path.join(dir, "b.json"), JSON.stringify({ ...minimal(), id: "other" }));
    expect((await loadProducts(dir, refs)).map((product) => product.id)).toEqual(["demo", "other"]);

    await writeFile(path.join(dir, "c.json"), JSON.stringify(minimal()));
    await expect(loadProducts(dir, refs)).rejects.toThrow(/Duplicate product id "demo"/);
  });
});

function minimal() {
  return {
    id: "demo",
    name: "Demo",
    url: "https://demo.test",
    pitch: "Demo is an app that does a demo thing well.",
    platform: { name: "threads" },
    discovery: { topicDescription: "people looking for a demo" },
    llm: { default: { provider: "anthropic", model: "claude-opus-5-5" } },
    approval: { chatId: 42 },
  };
}
