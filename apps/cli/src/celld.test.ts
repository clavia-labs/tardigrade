import { describe, expect, test } from "bun:test"
import { parse } from "jsonc-parser"

import {
  CELLD_OMITTED_KEYS,
  CELLD_SANDBOX_TRANSPORT,
  CELLD_SANDBOX_TRANSPORT_VAR,
  celldConfigOf,
  celldConfigWithVarOf
} from "./celld"

const wrangler = `{
  "name": "reviewer",
  "main": "worker.ts",
  "worker_loaders": [{ "binding": "LOADER" }],
  "observability": { "enabled": true },
  "limits": { "cpu_ms": 300000 },
  "vars": {
    "TARDIGRADE_ALARM_DELAY_MILLIS": "120000",
    "TARDIGRADE_CONFIG": { "models": { "default": { "provider": "openai", "model_id": "gpt-5.2" }, "allow": "*" } }
  }
}`

describe("Celld configuration", () => {
  test("derives the supported Wrangler view", () => {
    const derived = celldConfigOf(wrangler)
    const config = JSON.parse(derived.source) as Record<string, unknown>

    expect(derived.omitted).toEqual(CELLD_OMITTED_KEYS)
    expect(config).not.toHaveProperty("worker_loaders")
    expect(config).not.toHaveProperty("observability")
    expect(config).not.toHaveProperty("limits")
    expect((config["vars"] as Record<string, string>)["TARDIGRADE_CONFIG"]).toBe(
      '{"models":{"default":{"provider":"openai","model_id":"gpt-5.2"},"allow":"*"}}'
    )
    expect((config["vars"] as Record<string, string>)[CELLD_SANDBOX_TRANSPORT_VAR]).toBe(CELLD_SANDBOX_TRANSPORT)
  })

  test("updates shared config without replacing Celld settings", () => {
    const current = `{
  // Kept for the Celld fleet.
  "name": "reviewer",
  "vars": {
    "CELLD_ONLY": "kept",
    "TARDIGRADE_CONFIG": "{}"
  }
}\n`
    const updated = celldConfigWithVarOf(current, wrangler, "TARDIGRADE_CONFIG")

    expect(updated).toContain("// Kept for the Celld fleet.")
    expect(updated).toContain('"CELLD_ONLY": "kept"')
    const config = parse(updated) as { readonly vars: Readonly<Record<string, string>> }
    expect(config.vars["TARDIGRADE_CONFIG"]).toBe(
      '{"models":{"default":{"provider":"openai","model_id":"gpt-5.2"},"allow":"*"}}'
    )
  })
})
