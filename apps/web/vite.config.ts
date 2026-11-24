import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { apiProxyConfig } from './src/lib/api-proxy-target';

// Follows HELM_API_HOST from the shell so the proxy reaches the API bind (#159)
// and adds the operator token from HELM_API_TOKEN to /api and /ws (#160). The
// token stays in the dev server: it is not exposed through import.meta.env or define.
const apiProxy = apiProxyConfig(process.env);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: apiProxy,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
});
