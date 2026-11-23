import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "test/**/mock/**",
      // Grammar sources downloaded by scripts/grammars.mjs: third-party code, never run
      "grammars/.sources/**",
    ],
  },
});
