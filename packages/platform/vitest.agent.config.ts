import { cloudflareTest } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/workerd/agent.wrangler.jsonc" } })],
  // fsModuleCache is disabled because workerd cannot read Vitest's host filesystem cache.
  test: { fsModuleCache: false, include: ["test/workerd/agent-*.workers.ts"] },
})
