import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { type ZodError } from 'zod';
import { ProductSchema } from './product-schema.js';
import type { Product } from './product-schema.js';

export class ProductConfigError extends Error {
  constructor(
    message: string,
    public override readonly cause?: ZodError | Error,
    /** Preserved fs error code (e.g. 'ENOENT') — allows callers to check err.code without inspecting cause. */
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ProductConfigError';
  }
}

// Legacy snake_case specialist IDs → canonical kebab-case (ADR-022). Detected
// before schema validation so existing product.yaml files get an actionable
// migration message instead of a generic "unrecognized key" error.
const LEGACY_SPECIALIST_KEYS: Record<string, string> = {
  spec_writer: 'spec-writer',
  plan_writer: 'plan-writer',
  code_reviewer: 'code-reviewer',
  security_reviewer: 'security-reviewer',
  test_reviewer: 'test-reviewer',
  // ADR-024 rename: the code-review remediator moved from `remediation` to
  // `code-remediator` to join the spec/plan remediator family.
  remediation: 'code-remediator',
};

/**
 * Parses a YAML string and validates it against the ProductSchema.
 * Throws ProductConfigError with a path-aware message on failure.
 */
export function parseProductConfig(yamlContent: string): Product {
  let raw: unknown;
  try {
    raw = parseYaml(yamlContent);
  } catch (err) {
    throw new ProductConfigError('Failed to parse YAML', err as Error);
  }

  if (raw && typeof raw === 'object') {
    const specialists = (raw as { specialists?: unknown }).specialists;
    if (specialists && typeof specialists === 'object') {
      const legacy = Object.keys(specialists).filter((k) =>
        Object.prototype.hasOwnProperty.call(LEGACY_SPECIALIST_KEYS, k),
      );
      if (legacy.length > 0) {
        const renames = legacy.map((k) => `'${k}' → '${LEGACY_SPECIALIST_KEYS[k]}'`).join(', ');
        throw new ProductConfigError(
          `Invalid product.yaml — "specialists": specialist IDs must use kebab-case ` +
            `(e.g. 'spec-writer'). Rename ${renames}. See ADR-022 and the migration script ` +
            `in helm-knowledge/operations/migrations/2026-05-31-specialist-id-kebab.md.`,
        );
      }
    }
  }

  const result = ProductSchema.safeParse(raw);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const path = firstIssue?.path.join('.') ?? '(root)';
    const message = firstIssue?.message ?? 'Unknown validation error';
    throw new ProductConfigError(`Invalid product.yaml — "${path}": ${message}`, result.error);
  }

  return result.data;
}

/**
 * Reads a file from disk and calls parseProductConfig.
 * Uses node:fs/promises so it works in both Node.js (tests) and Bun (runtime).
 */
export async function parseProductConfigFromFile(filePath: string): Promise<Product> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    const fsErr = err as NodeJS.ErrnoException;
    throw new ProductConfigError(`Cannot read file: ${filePath}`, fsErr, fsErr.code);
  }
  return parseProductConfig(content);
}
