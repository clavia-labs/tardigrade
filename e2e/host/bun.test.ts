import { testInferenceLayer } from "@clavia/tardigrade-agent/testing/model"
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { defineActor, threadSupervisor } from "tardie/core"
import { createHost } from "tardie/bun"
import { NativeOutputSupport, agentMessageMethod, infer, nativeOutput } from "tardie/agent"

const meeseeks = defineActor("meeseeks", { message: agentMessageMethod }, [infer([nativeOutput], { models: { default: { provider: "test", model_id: "deterministic" }, allow: "*" } })])

const missingRequirements = () => {
  // @ts-expect-error inferenceClient and NativeOutputSupport must be supplied by the caller.
  return createHost({ actor: meeseeks, storage: ":memory:" })
}
void missingRequirements

test("thread setup gates child delivery and completion survives a Bun restart", async () => {
  const storage = await mkdtemp(join(tmpdir(), "thread-initialization-"))
  const started = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const ready = new Set<string>()
  const initialized: string[] = []
  let modelCalls = 0
  let fail = true
  const open = () => createHost({
    actor: meeseeks, storage,
    supervisor: threadSupervisor({ setup: ({ target, request }) => Effect.promise(async () => {
      initialized.push(`${target.instance}/${target.thread}`)
      if (request.kind === "child") {
        started.resolve()
        await released.promise
        if (fail) throw new Error("workspace unavailable")
      }
      ready.add(`${target.instance}/${target.thread}`)
    }) }),
    layersFor: (thread, instance) => Layer.mergeAll(
      Layer.succeed(NativeOutputSupport, { withTools: true }),
      testInferenceLayer({ react: () => Effect.sync(() => {
        expect(ready.has(`${instance}/${thread}`)).toBe(true)
        modelCalls++
        return { kind: "complete" as const, output: "workspace ready" }
      }) })
    )
  })
  let host = await open()
  try {
    const root = await host.allocateRootThread({ instance: "rick", name: "main" })
    let allocated = false
    const pending = host.allocateChildThread({ parent: root, name: "worker" }).then(
      () => { allocated = true; return undefined }, (error: unknown) => error
    )
    await started.promise
    expect(allocated).toBe(false)
    expect(modelCalls).toBe(0)
    released.resolve()
    expect(await pending).toBeInstanceOf(Error)
    expect(modelCalls).toBe(0)
    await host.close()
    fail = false
    host = await open()
    const restoredRoot = await host.allocateRootThread({ instance: "rick", name: "main" })
    const child = await host.allocateChildThread({ parent: restoredRoot, name: "worker" })
    expect(await child.message({ text: "work" }, { key: "work" })).toBe("workspace ready")
    expect(initialized).toEqual(["rick/main", "rick/worker", "rick/worker"])
    await host.close()
    host = await open()
    const again = await host.allocateChildThread({ parent: restoredRoot.coordinate, name: "worker" })
    expect(again.coordinate).toEqual(child.coordinate)
    expect(await again.message({ text: "work again" }, { key: "work-again" })).toBe("workspace ready")
    expect(initialized).toEqual(["rick/main", "rick/worker", "rick/worker"])
    expect(modelCalls).toBe(2)
  } finally {
    released.resolve()
    await host.close()
    await rm(storage, { recursive: true, force: true })
  }
})

test("public Bun host supplies component requirements across four threads", async () => {
  const storage = await mkdtemp(join(tmpdir(), "meeseeks-example-"))
  let calls = 0
  const openHost = () => createHost({
    actor: meeseeks,
    storage,
    layersFor: (thread) => Layer.mergeAll(
      Layer.succeed(NativeOutputSupport, { withTools: true }),
      testInferenceLayer( { react: (request) => Effect.sync(() => {
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
