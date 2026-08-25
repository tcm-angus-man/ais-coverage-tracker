import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // lib/* modules guard themselves with `import "server-only"`, which
      // throws outside an RSC bundle. Stub it so pure logic stays testable.
      "server-only": new URL("./tests/stubs/server-only.ts", import.meta.url).pathname,
    },
  },
});
