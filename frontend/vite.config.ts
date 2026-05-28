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
    // mc clone — 5173-5174 belongs to the canonical candleserv/frontend, 5175-5177
    // to modelserv/tgram (ss-devops/portRegistry.md). 5180 keeps this parallel
    // dev clone clear of all of them; strictPort fails loud on a collision.
    port: 5180,
    strictPort: true,
    proxy: {
      "/v1": "http://localhost:3019",
      "/monitor": "http://localhost:3019",
      "/health": "http://localhost:3019",
    },
  },
});
