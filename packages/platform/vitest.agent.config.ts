import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/workerd/agent.wrangler.jsonc" } })],
  test: { include: ["test/workerd/agent-*.workers.ts"] },
})
