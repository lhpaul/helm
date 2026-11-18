import type { Product } from '@helm/shared';
import type { SpawnPermissions } from '../runtime.js';

/**
 * Flag fragments that turn `gh api` into a mutation (#119): method overrides,
 * body/field flags (`-f`/`-F`, which also force POST) and `--input`. Short
 * flags are matched as prefixes so attached values (`-fbody=x`, `-XPOST`) are
 * denied too, and clusters led by the boolean `-i` (`-if`, `-iX`) as well.
 */
const GH_API_MUTATING_FLAGS = [
  '--method*',
  '--field*',
  '--raw-field*',
  '--input*',
  '-X*',
  '-f*',
  '-F*',
  '-i*X*',
  '-i*f*',
  '-i*F*',
] as const;

/**
 * Deny rules paired with `gh_api_read_only` (#119). `gh api` defaults to GET but
 * becomes a mutation with any flag above or the (POST-only) graphql endpoint.
 * Deny rules take precedence over allow rules in the Claude CLI. Each flag is
 * covered both right after `gh api` and later in the command line.
 */
export const GH_API_MUTATION_DENY_RULES: readonly string[] = [
  'Bash(gh api graphql*)',
  ...GH_API_MUTATING_FLAGS.flatMap((flag) => [`Bash(gh api ${flag})`, `Bash(gh api * ${flag})`]),
];

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
