import type { Product } from "../config/productSchema";
import { errorMessage, type AppContext } from "../core/context";
import type { NeutralPost, SearchQuery } from "../core/types";
import { PlatformError } from "../platforms/PlatformAdapter";

// Module 3: run every query through the platform adapter and merge results.
export async function discoverPosts(
  product: Product,
  queries: SearchQuery[],
  ctx: AppContext,
  now = new Date(),
): Promise<{ posts: NeutralPost[]; errors: string[] }> {
  const adapter = ctx.registry.adapter(product);
  const since = new Date(now.getTime() - product.discovery.sinceHours * 3600_000);
  const byId = new Map<string, NeutralPost>();
  const errors: string[] = [];

  for (const query of queries) {
    try {
      const posts = await adapter.search(query, {
        searchType: product.discovery.searchType,
        since,
        mediaType: product.discovery.mediaType,
        limit: product.discovery.perQueryLimit,
      });
      for (const post of posts) byId.set(post.id, post);
      ctx.log.debug({ product: product.id, query, found: posts.length }, "search done");
    } catch (err) {
      // Stop hammering the API on rate limits or account problems.
      if (err instanceof PlatformError && err.shouldPause) throw err;
      errors.push(`search "${query.q}" failed: ${errorMessage(err)}`);
    }
  }
  return { posts: [...byId.values()], errors };
}
