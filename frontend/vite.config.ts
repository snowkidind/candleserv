import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import path from "path";
import { execSync } from "child_process";

// Short SHA of HEAD at build time — stamps the bundle with the commit it was
// actually built from, so a stale frontend build shows a stale SHA in the header.
function gitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: __dirname }).toString().trim();
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  plugins: [TanStackRouterVite(), react()],
  define: {
    __GIT_COMMIT__: JSON.stringify(gitCommit()),
  },
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
    // candleserv backend.
    proxy: {
      "/v1": "http://localhost:3007",
      "/monitor": "http://localhost:3007",
      "/health": "http://localhost:3007",
    },
  },
});
