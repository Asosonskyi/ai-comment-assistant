// Character-trigram Jaccard similarity: cheap near-duplicate detection for short replies.

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function trigrams(text: string): Set<string> {
  const value = ` ${normalize(text)} `;
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= value.length; i++) grams.add(value.slice(i, i + 3));
  return grams;
}

export function similarity(a: string, b: string): number {
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared++;
  return shared / (left.size + right.size - shared);
}

export function maxSimilarity(text: string, others: string[]): number {
  return others.reduce((max, other) => Math.max(max, similarity(text, other)), 0);
}
