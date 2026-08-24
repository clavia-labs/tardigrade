import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./test/wrangler.jsonc" },
    miniflare: {
      bindings: {
        TARDIGRADE_TOKEN: "workers-test-token",
        TARDIGRADE_ALARM_DELAY_MILLIS: "60000"
      }
    }
  })],
  test: { include: ["test/**/*.workers.ts"] }
})
