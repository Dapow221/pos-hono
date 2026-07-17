/**
 * Offset pagination shared by every list endpoint (admin-UI style, per the
 * project convention: offset for admin tables, capped page sizes).
 *
 * Bad or missing query params fall back to defaults instead of erroring —
 * same forgiving behavior the report endpoints already use — and `limit` is
 * clamped so no client can request an unbounded page.
 */
export interface Pagination {
  limit: number;
  offset: number;
}

export function parsePagination(
  query: Record<string, string | undefined>,
  { defaultLimit = 20, maxLimit = 100 }: { defaultLimit?: number; maxLimit?: number } = {},
): Pagination {
  const rawLimit = Number(query.limit ?? defaultLimit);
  const limit =
    Number.isInteger(rawLimit) && rawLimit >= 1 ? Math.min(rawLimit, maxLimit) : defaultLimit;

  const rawOffset = Number(query.offset ?? 0);
  const offset = Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;

  return { limit, offset };
}

/** The standard list `meta` object: `{ total, limit, offset, hasMore }`. */
export function pageMeta(total: number, { limit, offset }: Pagination, count: number) {
  return { total, limit, offset, hasMore: offset + count < total };
}
