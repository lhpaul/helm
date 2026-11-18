// Vitest setup for @helm/api: tests run with API authentication on (#160).
// Set before any test file imports app.ts, which resolves the auth config once.
import { TEST_API_TOKEN } from './test-support/operator-token.js';

process.env.HELM_API_TOKEN = TEST_API_TOKEN;
delete process.env.HELM_API_AUTH;
