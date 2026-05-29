import { defineConfig } from "vitest/config";

export default defineConfig({
  // Force the esbuild target inline so it ignores tsconfig "ES2024",
  // which vite's esbuild plugin does not recognize.
  esbuild: {
    target: "es2022",
    tsconfigRaw: {
      compilerOptions: {
        target: "es2022",
        useDefineForClassFields: true,
      },
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    pool: "forks",
  },
});
