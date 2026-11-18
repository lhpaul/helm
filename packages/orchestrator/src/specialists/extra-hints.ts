/**
 * Renders the optional `## Hints` section injected into specialist prompts.
 *
 * Hints come from `product.specialists[<id>].extra_hints` in product.yaml.
 * Returns an empty string when no hints are configured; otherwise a
 * markdown section ready to interpolate into the prompt template.
 *
 * Order is preserved as written in YAML (deliberate: lets the operator
 * encode priority).
 */
export function buildExtraHintsSection(hints?: readonly string[]): string {
  if (!hints || hints.length === 0) return '';
  const lines = ['## Hints', '', ...hints.map((h) => `- ${h.trim()}`), '', '---', ''];
  return lines.join('\n');
}
