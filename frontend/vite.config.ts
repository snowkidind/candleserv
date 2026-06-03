import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import path from "path";

export default defineConfig({
  plugins: [TanStackRouterVite(), react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    host: "0.0.0.0",
    port: 5180,
    strictPort: true,
    // Canonical candleserv backend (CLAUDE.md port table). The multi-currency
    // clone (candleserv-mc) runs its own backend on :3019 with its own frontend.
    proxy: {
      "/v1": "http://localhost:3007",
      "/monitor": "http://localhost:3007",
      "/health": "http://localhost:3007",
    },
  },
});
