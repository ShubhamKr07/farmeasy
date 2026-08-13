/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

/**
 * Dedicated vitest config for the admin-dashboard React app. The app's build
 * config (vite.config.ts) hard-requires PORT/BASE_PATH env vars and pulls in
 * Replit-only plugins, so test runs need their own config. Resolves the `@`
 * alias the same way the build config does.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["src/pages/inventory/Inventory.test.tsx"],
  },
});
