import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
  },
  resolve: {
    alias: {
      "@flightbox/core": resolve(__dirname, "packages/core/src/index.ts"),
      "@flightbox/sdk": resolve(__dirname, "packages/sdk/src/index.ts"),
      "@flightbox/transform": resolve(__dirname, "packages/transform/src/index.ts"),
    },
  },
});
