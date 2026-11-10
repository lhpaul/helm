import type { Product } from '@helm/shared';

/**
 * Resolves the spawn timeout (ms) for a specialist (#118).
 *
 * `product.specialists[<id>].timeout_sec` wins when configured; otherwise the
 * specialist's built-in `fallbackMs` applies. `undefined` means "let the
 * runtime use its own default" (spec-writer / plan-writer).
 */
export function resolveSpecialistTimeoutMs(
  product: Product,
  specialistId: keyof Product['specialists'],
  fallbackMs?: number,
): number | undefined {
  const sec = product.specialists[specialistId]?.timeout_sec;
  return sec !== undefined ? sec * 1_000 : fallbackMs;
}
