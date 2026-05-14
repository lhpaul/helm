import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { type ZodError } from 'zod';
import { ProductSchema } from './product-schema.js';
import type { Product } from './product-schema.js';

export class ProductConfigError extends Error {
  constructor(
    message: string,
    public override readonly cause?: ZodError | Error,
  ) {
    super(message);
    this.name = 'ProductConfigError';
  }
}

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
    throw new ProductConfigError(`Cannot read file: ${filePath}`, err as Error);
  }
  return parseProductConfig(content);
}
