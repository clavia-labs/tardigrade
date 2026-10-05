import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

export default defineConfig({
  cacheDir: "/tmp/tardigrade-vite-cache",
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/agent/wrangler.jsonc" } })],
  test: { include: ["test/agent/**/*.workers.ts"] },
})
