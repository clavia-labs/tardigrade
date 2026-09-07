import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { defineActor } from "tardie/core"
import { createHost } from "tardie/bun"
import { Infer, NativeOutputSupport, agentMessageMethod, infer, nativeOutput } from "tardie/agent"

const meeseeks = defineActor("meeseeks", { message: agentMessageMethod }, [infer([nativeOutput], { models: { default: { provider: "test", model_id: "deterministic" }, allow: "*" } })])

const missingRequirements = () => {
  // @ts-expect-error Infer and NativeOutputSupport must be supplied by the caller.
  return createHost({ actor: meeseeks, storage: ":memory:" })
}
void missingRequirements

test("public Bun host supplies component requirements across four threads", async () => {
  const storage = await mkdtemp(join(tmpdir(), "meeseeks-example-"))
  let calls = 0
  const openHost = () => createHost({
    actor: meeseeks,
    storage,
    layersFor: (thread) => Layer.mergeAll(
      Layer.succeed(NativeOutputSupport, { withTools: true }),
      Layer.succeed(Infer, { react: (request) => Effect.sync(() => {
        calls++
        const message = request.trajectory.findLast((event) => event.type === "MessageReceived")
        return { kind: "complete" as const, output: `${thread}: ${String(message?.text)}` }
      }) })
    )
  })
  let host = await openHost()
  try {
    const rickMain = await host.allocateRootThread({ instance: "rick", name: "main" })
    const rickLab = await host.allocateRootThread({ instance: "rick", name: "lab" })
    const mortyMain = await host.allocateRootThread({ instance: "morty", name: "main" })
    const mortyLab = await host.allocateRootThread({ instance: "morty", name: "lab" })
    expect([rickMain, rickLab, mortyMain, mortyLab].map((thread) => thread.coordinate)).toEqual([
      { actor: "meeseeks", instance: "rick", thread: "main" },
      { actor: "meeseeks", instance: "rick", thread: "lab" },
      { actor: "meeseeks", instance: "morty", thread: "main" },
      { actor: "meeseeks", instance: "morty", thread: "lab" }
    ])
    const rickResponse = await rickLab.message({ text: "Design an experiment to test the portal gun's power source." }, { key: "portal-experiment" })
    const mortyResponse = await mortyMain.message({ text: "Help me plan my day around school and homework." }, { key: "school-plan" })
    expect(rickResponse).toBe("lab: Design an experiment to test the portal gun's power source.")
    expect(mortyResponse).toBe("main: Help me plan my day around school and homework.")
    expect(await rickLab.message({ text: "retry" }, { key: "portal-experiment" })).toBe(rickResponse)
    await host.close()
    host = await openHost()
    const restoredLab = await host.allocateRootThread({ instance: "rick", name: "lab" })
    expect(await restoredLab.message({ text: "retry after restart" }, { key: "portal-experiment" })).toBe(rickResponse)
    expect(calls).toBe(2)
  } finally {
    await host.close()
    await rm(storage, { recursive: true, force: true })
  }
})
