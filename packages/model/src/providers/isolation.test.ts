import { expect, test } from "bun:test"
import { mkdtemp, copyFile, symlink, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

test("a missing selected provider produces an actionable model failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tardie-provider-"))
  try {
    await copyFile(new URL("./layer.ts", import.meta.url), join(directory, "layer.ts"))
    await symlink(fileURLToPath(new URL("../../../../node_modules", import.meta.url)), join(directory, "node_modules"))
    const source = `
      import { Effect, Stream } from "effect"
      import { LanguageModel } from "effect/unstable/ai"
      import { FetchHttpClient } from "effect/unstable/http"
      import { providerLayer } from "./layer.ts"
      const result = await Effect.runPromise(Effect.gen(function* () {
        const model = yield* LanguageModel.LanguageModel
        return yield* model.streamText({ prompt: "Hello" }).pipe(Stream.runCollect, Effect.result)
      }).pipe(Effect.provide(providerLayer({ provider: "bedrock", client: { region: "us-east-1" }, model: { model: "fixture" } })), Effect.provide(FetchHttpClient.layer)))
      process.stdout.write(JSON.stringify(result))
    `
    const child = Bun.spawn([process.execPath, "--eval", source], { cwd: directory, env: {}, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    const result = JSON.parse(stdout)
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "AiError", reason: { _tag: "UnknownError" } } })
    expect(result.failure.reason.description).toContain("@tardie/ai-bedrock")
    expect(result.failure.reason.description).toContain("install")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
