import { z } from 'zod';

/**
 * Schema for .helm/products.yaml — the multi-product registry file.
 *
 * Each entry lists a `path` to a knowledge repository that contains its own
 * .helm/product.yaml. Paths are resolved relative to the parent directory of
 * HELM_KNOWLEDGE_REPO_PATH (the "sibling layout" assumption documented in
 * ADR-004). Absolute paths are also accepted.
 *
 * Example:
 *   products:
 *     - path: .                             # this repo
 *     - path: ../helm-playground-knowledge  # sibling repo
 */
export const ProductRegistryEntrySchema = z
  .object({
    path: z.string().min(1, 'path must not be empty'),
  })
  .strict();

export const ProductRegistrySchema = z
  .object({
    products: z.array(ProductRegistryEntrySchema).min(1, 'registry must list at least one product'),
  })
  .strict();

export type ProductRegistryEntry = z.infer<typeof ProductRegistryEntrySchema>;
export type ProductRegistry = z.infer<typeof ProductRegistrySchema>;
