// Cursor-based pagination — framework-agnostic helpers shared across
// repository layers (api modules + future worker queries).

export const PAGINATION_DEFAULT_LIMIT = 50;
export const PAGINATION_MAX_LIMIT = 200;

export type PaginationParams = {
  cursor?: string;
  limit?: number;
};

export type PaginatedResult<T> = {
  items: T[];
  nextCursor: string | null;
};

export function clampLimit(requested: number | undefined): number {
  const n = requested ?? PAGINATION_DEFAULT_LIMIT;
  if (n < 1) return PAGINATION_DEFAULT_LIMIT;
  if (n > PAGINATION_MAX_LIMIT) return PAGINATION_MAX_LIMIT;
  return n;
}

export function buildNextCursor<T extends { createdAt: Date }>(
  items: T[],
  limit: number,
): string | null {
  if (items.length < limit) return null;
  return items[items.length - 1].createdAt.toISOString();
}
