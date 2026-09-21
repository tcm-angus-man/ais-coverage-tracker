import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url)).replace(/\/$/, "");

export default defineConfig({
  resolve: {
    alias: {
      // Matches tsconfig's path alias so API route modules (which import via
      // `@/...`) can be loaded and mocked in tests.
      "@": root,
      // lib/* modules guard themselves with `import "server-only"`, which
      // throws outside an RSC bundle. Stub it so pure logic stays testable.
      "server-only": new URL("./tests/stubs/server-only.ts", import.meta.url).pathname,
    },
  },
});
