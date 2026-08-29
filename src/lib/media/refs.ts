/**
 * Extract numeric media IDs from a post's `mediaFiles` JSONB column, which stores
 * BOTH formats — a plain `number[]` and a legacy `{ id, url }[]` (see schema.ts /
 * the schema-migrations rule). Non-numeric and malformed entries are dropped.
 */
export function parseMediaIds(refs: unknown): number[] {
  if (!Array.isArray(refs)) return [];
  return refs
    .map((e) => (typeof e === 'number' ? e : (e as { id?: number } | null)?.id))
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
}
