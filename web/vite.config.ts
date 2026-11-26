// Builds the page into dist/web, which `skeinwise serve` hands out. `pnpm dev:web` runs Vite against a server
// already started with `skeinwise serve` on the default port.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  build: {
    outDir: fileURLToPath(new URL('../dist/web', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    rolldownOptions: {
      output: {
        // three.js comes as two files, its core and its renderer. Each gets its own chunk, so neither passes Vite's
        // size warning; the scene imports both, and all three load together the first time the brain is drawn.
        codeSplitting: {
          groups: [
            {
              test: /node_modules[\\/]three[\\/]/,
              name: (id) => (/three\.core\.js$/.test(id) ? 'three-core' : 'three-renderer'),
            },
          ],
        },
      },
    },
  },
  server: {
    port: 5319,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7319',
        changeOrigin: true,
        configure: (proxy) => proxy.on('proxyReq', (req) => req.removeHeader('origin')),
      },
    },
  },
});
