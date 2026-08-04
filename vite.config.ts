import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri drives this dev server; the port is fixed because tauri.conf.json's
// `build.devUrl` points at it and Tauri will not follow a port reassignment.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // The Rust side has its own watcher; don't let Vite churn on target/.
      ignored: ["**/src-tauri/**", "**/library/**", "**/engine/**"],
    },
  },
  build: {
    // Only ever runs inside a modern WebKit/WebView2 — no legacy transpiling.
    target: "esnext",
    sourcemap: false,
  },
});
