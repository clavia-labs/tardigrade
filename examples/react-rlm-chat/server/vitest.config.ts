import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: {
    bindings: { OPENROUTER_API_KEY: "fixture", TARDIGRADE_MODEL_CATALOG_LOAD_POLICY: "cache-first", TARDIGRADE_ALARM_DELAY_MILLIS: "60000" }
  } })],
  test: { include: ["*.workers.ts"] }
})
