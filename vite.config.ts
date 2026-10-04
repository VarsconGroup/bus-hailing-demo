import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build` -> normal multi-file build in dist/ (e.g. for GitHub Pages).
// `npm run build:single` -> one self-contained dist-single/index.html you can email or open offline.
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'single' ? [viteSingleFile()] : [],
  build: { outDir: mode === 'single' ? 'dist-single' : 'dist' },
  worker: { format: 'es' },
}));
