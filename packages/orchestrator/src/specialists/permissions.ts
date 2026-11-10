import type { Product } from '@helm/shared';
import type { SpawnPermissions } from '../runtime.js';

/**
 * Deny rules paired with `gh_api_read_only` (#119). `gh api` defaults to GET but
 * becomes a mutation with a method override, any body/field flag, `--input`, or
 * the (POST-only) graphql endpoint, so those forms are denied. Deny rules take
 * precedence over allow rules in the Claude CLI.
 */
export const GH_API_MUTATION_DENY_RULES = [
  'Bash(gh api * --method*)',
  'Bash(gh api * -X*)',
  'Bash(gh api * -f *)',
  'Bash(gh api * -F *)',
  'Bash(gh api * --field*)',
  'Bash(gh api * --raw-field*)',
  'Bash(gh api * --input*)',
  'Bash(gh api graphql*)',
  'Bash(gh api -X*)',
  'Bash(gh api --method*)',
  'Bash(gh api -f *)',
  'Bash(gh api -F *)',
  'Bash(gh api --field*)',
  'Bash(gh api --raw-field*)',
  'Bash(gh api --input*)',
] as const;

/**
 * Maps `product.specialists[<id>].permissions` to spawn permissions (#119).
 * Returns `undefined` when nothing is configured so default spawns are
 * byte-for-byte unchanged. Never produces a permission-mode change.
 */
export function resolveSpecialistPermissions(
  product: Product,
  specialistId: keyof Product['specialists'],
): SpawnPermissions | undefined {
  const cfg = product.specialists[specialistId]?.permissions;
  if (!cfg) return undefined;

  const allowedTools = [...(cfg.allowed_tools ?? [])];
  const disallowedTools: string[] = [];
  if (cfg.gh_api_read_only) {
    allowedTools.push('Bash(gh api:*)');
    disallowedTools.push(...GH_API_MUTATION_DENY_RULES);
  }

  const out: SpawnPermissions = {};
  if (cfg.add_dirs?.length) out.addDirs = [...cfg.add_dirs];
  if (allowedTools.length) out.allowedTools = [...new Set(allowedTools)];
  if (disallowedTools.length) out.disallowedTools = disallowedTools;
  return Object.keys(out).length > 0 ? out : undefined;
}
