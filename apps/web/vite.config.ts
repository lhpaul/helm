import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { apiProxyTargets } from './src/lib/api-proxy-target';

// Follows HELM_API_HOST from the shell so the proxy reaches the API bind (#159).
const apiTarget = apiProxyTargets(process.env);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': apiTarget.http,
      '/ws': {
        target: apiTarget.ws,
        ws: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
});
