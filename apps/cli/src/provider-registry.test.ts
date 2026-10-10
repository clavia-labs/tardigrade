import { expect, test } from "bun:test"
import { providerRegistrySource } from "./provider-registry"
import { PRESETS, providerAnswersFrom } from "./setup"

test("Codex setup selects the direct provider beside ordinary OpenAI", () => {
  const preset = PRESETS.find(value => value.provider === "codex")
  expect(preset).toMatchObject({ protocol: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex" })
  expect(preset?.modelExample).toBeUndefined()
  const configured = providerAnswersFrom({ provider: "codex", config: '{"env":["CODEX_ACCESS_TOKEN"]}' })
  expect(configured).toMatchObject({ provider: "codex", protocol: "openai-responses", env: ["CODEX_ACCESS_TOKEN"] })
  const registry = providerRegistrySource({ codex: { protocol: "openai-responses" }, openai: { protocol: "openai-responses" } })
  expect(registry).toContain('from "tardie/model/providers/codex"')
  expect(registry).toContain('case "codex": return provider0(options)')
  expect(registry).toContain('case "openai": return provider1(options)')
})
