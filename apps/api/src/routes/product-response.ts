import type { Product } from '@helm/shared';

export function publicProductResponse(product: Product): Product {
  const response = structuredClone(product);
  if (response.notifications) {
    delete response.notifications.slack_webhook;
  }
  return response;
}
