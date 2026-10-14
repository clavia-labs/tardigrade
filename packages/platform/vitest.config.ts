import { cloudflareTest } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/workerd/wrangler.jsonc" } })],
  // fsModuleCache is disabled because workerd cannot read Vitest's host filesystem cache.
  test: { provide: { longTests: process.env.TARDIGRADE_TEST_LONG === "1" }, fsModuleCache: false, include: process.env.TARDIGRADE_TEST_LONG === "1"
    ? ["test/workerd/input-digest.workers.ts", "test/workerd/thread-layout.workers.ts"]
    : ["test/workerd/**/*.workers.ts"],
    exclude: process.env.TARDIGRADE_TEST_LONG === "1" ? [] : ["test/workerd/input-digest.workers.ts", "test/workerd/agent-*.workers.ts"],
  },
})

declare module "vitest" {
  export interface ProvidedContext { longTests: boolean }
}
