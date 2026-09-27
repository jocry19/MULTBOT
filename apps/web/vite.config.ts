import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { conditions: ["source", "module", "browser", "development|production"] },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", ws: true, changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router"],
          charts: ["lightweight-charts"],
          query: ["@tanstack/react-query"],
        },
      },
    },
  },
});
