import { defineConfig } from "vite";

/**
 * Configuration Vite alignée sur Tauri v2 :
 * - port fixe (1420) car `devUrl` doit rester stable ;
 * - cible Chromium 105 = WebView2 minimal supporté ;
 * - `src-tauri` exclu du watcher (c'est Rust qui rebuild).
 */
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "chrome105",
    sourcemap: false,
  },
});
