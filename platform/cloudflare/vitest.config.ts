import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"
import { readFile } from "node:fs/promises"

const catalogMigration = await readFile(new URL("./migrations/0001_catalog.sql", import.meta.url), "utf8")

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./test/wrangler.jsonc" },
    miniflare: {
      bindings: {
        APPLICATION_PREFIX: "workers",
        CATALOG_MIGRATION: catalogMigration,
        TARDIGRADE_TOKEN: "workers-test-token",
        TARDIGRADE_ALARM_DELAY_MILLIS: "60000",
        TARDIGRADE_MODEL_CATALOG_URL: "https://models.test/catalog.json",
        TARDIGRADE_MODEL_CATALOG_LOAD_POLICY: "cache-first",
        TARDIGRADE_CONFIG: JSON.stringify({
          models: {
            default: { provider: "openai", model_id: "gpt-test" },
            allow: "*",
            providers: {
              openai: {
                baseUrl: "https://api.openai.test/v1",
                protocol: "openai-chat-completions",
                env: ["OPENAI_API_KEY"]
              }
            }
          }
        }),
        OPENAI_API_KEY: "workers-test-key"
      }
    }
  })],
  test: { include: ["test/**/*.workers.ts"] }
})
