import type { Product } from "../config/productSchema";
import type { AppContext } from "../core/context";
import type { SearchQuery } from "../core/types";
import { QueryPlanSchema, queryPlannerPrompt } from "../prompts/queryPlanner";

// Module 2: turn the product request into search queries. Config keywords/tags
// always come first; the LLM fills the remaining slots.
export async function planQueries(product: Product, ctx: AppContext): Promise<SearchQuery[]> {
  const { discovery } = product;
  const seeds: SearchQuery[] = [
    ...discovery.keywords.map((q) => ({ q, mode: "KEYWORD" as const })),
    ...discovery.tags.map((q) => ({ q: q.replace(/^#/, ""), mode: "TAG" as const })),
  ];

  let planned: SearchQuery[] = [];
  const remaining = discovery.maxQueries - seeds.length;
  if (discovery.useQueryPlanner && remaining > 0) {
    const { provider, choice } = ctx.registry.llm(product, "queryPlanner");
    const prompt = queryPlannerPrompt(product, remaining);
    const result = await provider.generateJson(QueryPlanSchema, "query_plan", {
      model: choice.model,
      effort: choice.effort,
      ...prompt,
    });
    planned = result.queries;
  }

  return dedupeQueries([...seeds, ...planned]).slice(0, discovery.maxQueries);
}

export function dedupeQueries(queries: SearchQuery[]): SearchQuery[] {
  const seen = new Set<string>();
  return queries
    .map((query) => ({ ...query, q: query.q.trim() }))
    .filter((query) => {
      const key = `${query.mode}:${query.q.toLowerCase()}`;
      if (!query.q || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
