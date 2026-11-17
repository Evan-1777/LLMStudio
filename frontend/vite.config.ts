import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const gatewayTarget = process.env.VITE_GATEWAY_TARGET || 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: gatewayTarget,
        changeOrigin: true,
      },
      '/healthz': {
        target: gatewayTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    css: true,
  },
});
