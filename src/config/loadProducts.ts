import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { LlmStages, llmChoiceFor, ProductSchema, type Product } from "./productSchema";

export interface ProductRefs {
  platforms: string[];
  llmProviders: string[];
  approvalChannels: string[];
}

export async function loadProducts(dir: string, refs: ProductRefs): Promise<Product[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
  if (files.length === 0) throw new Error(`No product configs (*.json) found in ${dir}`);

  const products: Product[] = [];
  for (const file of files) {
    const fullPath = path.join(dir, file);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(fullPath, "utf8"));
    } catch (err) {
      throw new Error(`${fullPath}: invalid JSON (${(err as Error).message})`);
    }
    products.push(parseProduct(raw, fullPath, refs));
  }

  const ids = new Set<string>();
  for (const product of products) {
    if (ids.has(product.id)) throw new Error(`Duplicate product id "${product.id}" in ${dir}`);
    ids.add(product.id);
  }
  return products;
}

export function parseProduct(raw: unknown, source: string, refs: ProductRefs): Product {
  const result = ProductSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`${source}: invalid product config\n${z.prettifyError(result.error)}`);
  }
  const product = result.data;

  if (!refs.platforms.includes(product.platform.name)) {
    throw new Error(`${source}: unknown platform "${product.platform.name}" (known: ${refs.platforms.join(", ")})`);
  }
  if (!refs.approvalChannels.includes(product.approval.channel)) {
    throw new Error(
      `${source}: unknown approval channel "${product.approval.channel}" (known: ${refs.approvalChannels.join(", ")})`,
    );
  }
  for (const stage of LlmStages) {
    const { provider } = llmChoiceFor(product, stage);
    if (!refs.llmProviders.includes(provider)) {
      throw new Error(`${source}: unknown LLM provider "${provider}" for ${stage} (known: ${refs.llmProviders.join(", ")})`);
    }
  }
  return product;
}
