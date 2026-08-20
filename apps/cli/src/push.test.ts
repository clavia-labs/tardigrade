import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { ACTOR_MANIFEST_FILE, ACTOR_MODULE_FILE } from "./build"
import { PUSH_PATH, pushActor } from "./push"

let root = ""

afterEach(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true })
})

const entry = async (): Promise<string> => {
  root = await mkdtemp(join(process.cwd(), ".tdg-push-test-"))
  const path = join(root, "actor.ts")
  await writeFile(path, `
    import { defineActor } from "tardie"
    export default defineActor({ name: "reviewer", actor: { reactors: [], keyOf: () => "root" } })
  `, "utf8")
  return path
}

describe("pushActor", () => {
  test("installs the built bytes locally", async () => {
    const path = await entry()
    const pushed = await pushActor(path, { cwd: root, target: "local" })
    const installed = join(root, ".tardigrade", "actors", "reviewer")
    expect(pushed.location).toBe(installed)
    expect(await readFile(join(installed, ACTOR_MODULE_FILE), "utf8"))
      .toBe(await readFile(join(pushed.directory, ACTOR_MODULE_FILE), "utf8"))
    expect(JSON.parse(await readFile(join(installed, ACTOR_MANIFEST_FILE), "utf8"))).toEqual(pushed.manifest)
  })

  test("sends the same artifact to a hosted server", async () => {
    const path = await entry()
    let request: Request | undefined
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (input instanceof Request) request = new Request(input, init)
      else request = new Request(String(input), init)
      return new Response(null, { status: 204 })
    }) as typeof globalThis.fetch
    const pushed = await pushActor(path, {
      cwd: root,
      target: "hosted",
      baseUrl: "https://example.test/",
      token: "secret",
      fetch
    })
    expect(request?.url).toBe(`https://example.test${PUSH_PATH}`)
    expect(request?.method).toBe("PUT")
    expect(request?.headers.get("authorization")).toBe("Bearer secret")
    const payload = JSON.parse(await request!.text())
    expect(payload.manifest).toEqual(pushed.manifest)
    expect(payload.module).toBe(await readFile(join(pushed.directory, ACTOR_MODULE_FILE), "utf8"))
  })
})
