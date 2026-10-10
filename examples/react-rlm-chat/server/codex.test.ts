import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { modelSettingsFor } from "tardie/model/settings"
import { codexModelServices } from "./codex"

for (const override of [undefined, "16000"]) {
  test(`Codex chat binds discovered metadata and supports a context override (${override ?? "discovered"})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "tardie-codex-chat-"))
    const credentialFile = join(directory, "credentials.json")
    await writeFile(credentialFile, JSON.stringify({ accessToken: "private-test-token", refreshToken: "private-refresh-token", accountId: "fixture", expiresAt: 9_999_999_999_000 }))
    const server = Bun.serve({ port: 0, fetch: request => {
      expect(request.headers.get("authorization")).toBe("Bearer private-test-token")
      expect(new URL(request.url).pathname).toBe("/models")
      return Response.json({ models: [{ slug: "fixture-model", visibility: "list", context_window: 32000 }] })
    } })
    try {
      const services = await codexModelServices({
        CODEX_MODEL: "fixture-model", CODEX_CREDENTIALS_FILE: credentialFile,
        CODEX_STATE_DIRECTORY: directory, CODEX_BASE_URL: server.url.toString().replace(/\/$/, ""),
        ...(override === undefined ? {} : { CODEX_CONTEXT_WINDOW_TOKENS: override })
      })
      expect(services.config.model.default).toEqual({ provider: "codex", model_id: "fixture-model" })
      const settings = await Effect.runPromise(modelSettingsFor().pipe(Effect.provide(services.layers)))
      expect(settings).toMatchObject({ provider: "codex", model: "fixture-model", outputTokenLimitEnforcement: "unsupported" })
      const persisted = await readFile(join(directory, "fixture-model", "models.lock.json"), "utf8")
      expect(JSON.parse(persisted).models[0].contextWindowTokens).toBe(Number(override ?? "32000"))
      expect(persisted).not.toContain("private-test-token")
      expect(await readFile(join(directory, "fixture-model", "wrangler.jsonc"), "utf8")).not.toContain("private-test-token")
    } finally {
      server.stop(true)
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test("Codex chat requires an explicit model before reading credentials", async () => {
  await expect(codexModelServices({})).rejects.toThrow("Set CODEX_MODEL")
})
