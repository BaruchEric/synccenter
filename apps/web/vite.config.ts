import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  // Root for dev (Vite serves the SPA at /), overridable for the deployed
  // bundle, which the API serves under /app so it cannot shadow the root-mounted
  // API routes the CLI, MCP server and Prometheus all call. `App.tsx` reads the
  // same value back as `import.meta.env.BASE_URL` for the router basename.
  base: process.env.VITE_BASE ?? "/",
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Forward API calls to the local SyncCenter API so cookies/auth Just Work.
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
