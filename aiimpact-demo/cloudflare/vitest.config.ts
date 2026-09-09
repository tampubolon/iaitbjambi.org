import { cloudflarePool } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * The sanitizer uses HTMLRewriter, which exists only in the Workers runtime.
 * Testing it against a node stand-in would test a different implementation
 * than the one that ships — not acceptable for the module deciding what
 * untrusted markup reaches the organisation's domain.
 *
 * Pool API note: 0.22 replaced `defineWorkersConfig` from
 * `@cloudflare/vitest-pool-workers/config` with `cloudflarePool` on the main
 * entry. Older guides still show the former.
 */
export default defineConfig({
  test: {
    pool: cloudflarePool({
      wrangler: { configPath: "./wrangler.toml" },
    }),
  },
});
