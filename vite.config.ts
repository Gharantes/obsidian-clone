import { defineConfig } from 'vite'

// The frontend Tauri loads: served on a fixed port in dev, built into dist/ for `tauri build`.
export default defineConfig({
  root: 'src/renderer',
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { outDir: '../../dist', emptyOutDir: true, target: 'es2022' }
})
