import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { providerLayer as anthropic } from "./anthropic"
import { providerLayer as openai } from "./openai"
import { providerLayer as compatible } from "./openai-compat"

for (const entry of ["../host.ts", "./anthropic.ts", "./openai.ts", "./openai-compat.ts"]) test(`${entry} does not resolve AWS or Smithy`, async () => {
  const resolved: string[] = []
  const bundle = await Bun.build({
    entrypoints: [fileURLToPath(new URL(entry, import.meta.url))],
    target: "browser",
    plugins: [{ name: "reject-unselected-bedrock", setup(build) {
      build.onResolve({ filter: /^(?:@tardie\/ai-bedrock(?:\/|$)|(?:@aws-sdk|@smithy)\/)/ }, ({ path }) => {
        resolved.push(path)
        throw new Error(`Unselected provider dependency: ${path}`)
      })
    } }]
  })
  expect(resolved).toEqual([])
  expect(bundle.logs.filter((log) => log.level === "error")).toEqual([])
  expect(bundle.success).toBe(true)
})

test("an explicitly supplied provider rejects a mismatched protocol before dispatch", () => {
  const options = { endpoint: "https://unused.invalid", client: {}, model: { model: "fixture" } }
  expect(() => anthropic({ ...options, provider: "openai" })).toThrow("supply the matching providerLayer")
  expect(() => openai({ ...options, provider: "anthropic" })).toThrow("supply the matching providerLayer")
  expect(() => compatible({ ...options, provider: "openai" })).toThrow("supply the matching providerLayer")
})
