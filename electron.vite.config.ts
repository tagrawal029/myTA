import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    // CommonJS, so the preload also runs in a sandboxed renderer.
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') }, output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          overlay: resolve(__dirname, 'src/renderer/overlay/index.html'),
          settings: resolve(__dirname, 'src/renderer/settings/index.html'),
          camera: resolve(__dirname, 'src/renderer/camera/index.html'),
          marks: resolve(__dirname, 'src/renderer/marks/index.html'),
        },
      },
    },
  },
});
