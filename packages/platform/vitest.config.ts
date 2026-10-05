import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/workerd/wrangler.jsonc" } })],
  test: { include: process.env.TARDIGRADE_TEST_LONG === "1"
    ? ["test/workerd/input-digest.workers.ts"]
    : ["test/workerd/**/*.workers.ts"],
    exclude: process.env.TARDIGRADE_TEST_LONG === "1" ? [] : ["test/workerd/input-digest.workers.ts", "test/workerd/agent-*.workers.ts"],
  },
})
