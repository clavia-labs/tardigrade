import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      bindings: { TARDIGRADE_TOKEN: "workers-test-token" },
      d1Databases: ["REGISTRY"]
    }
  })],
  test: { include: ["test/**/*.workers.ts"] }
})
