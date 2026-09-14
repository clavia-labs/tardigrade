import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./test-inference/wrangler.jsonc" }, miniflare: { bindings: { TARDIGRADE_ALARM_DELAY_MILLIS: "60000", TARDIGRADE_TOKEN: "fixture" } } })],
  test: { include: ["test-inference/**/*.workers.ts"] }
})
