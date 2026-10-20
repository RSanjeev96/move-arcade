import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.BASE_PATH ?? '/move-arcade/',
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  server: { host: true },
});
