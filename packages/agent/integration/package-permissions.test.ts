import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { actor } from "@clavia/tardigrade-core/actor"
import type { Event } from "@clavia/tardigrade-core/event"
import { EventLog, withWatermark } from "@clavia/tardigrade-core/log"
import { replayProjection } from "@clavia/tardigrade-core/projection"
import { Self, settleActor } from "@clavia/tardigrade-core/runtime"
import { Router } from "@clavia/tardigrade-core/transport/router"
import { threadAddressOf } from "@clavia/tardigrade-core/transport/endpoint"
import { definePackage } from "@clavia/tardigrade-code/package/definition"
import { guestBindings, Sandbox } from "@clavia/tardigrade-code/sandbox/service"
import { testMachineOf } from "../fixtures/component"
import { codeMode } from "../src/component/code/index"
import { tools } from "../src/component/tool/index"
import { permissions } from "../src/component/permissions/index"

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: ReadonlyArray<string>
) => (...bindings: ReadonlyArray<unknown>) => Promise<unknown>

const program = `
  const content = await files.read({ path: "a.txt" })
  return await files.write({ path: "b.txt", content })
`

test.each(["code", "tools"] as const)("%s preserves child permission holds and denial across restart", async adapter => {
  let reads = 0
  let writes = 0
  const files = definePackage({
    name: "files",
    description: "Files for the permission scenario",
    annotations: { read: { readOnlyHint: true }, write: { readOnlyHint: false } },
    methods: {
      read: () => Effect.sync(() => { reads++; return "contents" }),
      write: () => Effect.sync(() => { writes++; return "written" })
    }
  })
  const create = () => {
    const governed = permissions(files, {
      request: (work, view) => view.pendingCalls?.find(call => call.key === work.key)?.name === "files.write"
        ? { action: "write", resource: "b.txt", reason: "Save the copied file" }
        : undefined,
      onDenied: (reason, respond) => respond({ error: reason })
    })
    return { governed, definition: actor({ name: "package-permissions", methods: {}, components: [adapter === "code" ? codeMode([governed]) : tools([governed])] }) }
  }
  const log: Event[] = [
    { type: "MessageReceived", id: "turn", text: "Copy the file", at: 0 },
    ...(adapter === "code"
      ? [{ type: "ToolCalled", turn: "turn", callId: "execute", name: "execute", arguments: { code: program }, at: 1 }]
      : [
        { type: "ToolCalled", turn: "turn", callId: "read", name: "files_read", arguments: { path: "a.txt" }, at: 1 },
        { type: "ToolCalled", turn: "turn", callId: "write", name: "files_write", arguments: { path: "b.txt", content: "contents" }, at: 2 }
      ])
  ]
  const environment = Layer.mergeAll(
    KeyValueStore.layerMemory,
    Layer.succeed(Self, threadAddressOf("package-permissions", "main", "root")),
    Layer.succeed(Router, { send: () => Effect.void }),
    Layer.succeed(EventLog, withWatermark({
      read: Effect.sync(() => [...log]),
      append: events => Effect.sync(() => { log.push(...events) })
    })),
    Layer.succeed(Sandbox, {
      run: (code, bindings) => Effect.promise(async () => {
        const scope = guestBindings(bindings)
        const names = Object.keys(scope)
        return { result: await new AsyncFunction(...names, code)(...names.map(name => scope[name])) }
      })
    })
  )
  const first = create()
  await Effect.runPromise(settleActor(first.definition).pipe(Effect.provide(environment)))
  expect(log.filter(event => event.type === "PackageCalled").map(event => event.name))
    .toEqual(["files.read", "files.write"])
  expect(reads).toBe(1)
  expect(writes).toBe(0)
  expect(log.filter(event => event.type === "ToolReturned")).toHaveLength(adapter === "code" ? 0 : 1)

  const restarted = create()
  const held = replayProjection(testMachineOf(restarted.governed), log)
  const pending = held.view.permissions.filter(request => request.status === "pending")
  expect(pending).toHaveLength(1)
  const before = [...log]
  await Effect.runPromise(settleActor(restarted.definition).pipe(Effect.provide(environment)))
  expect(log).toEqual(before)
  expect(reads).toBe(1)
  expect(writes).toBe(0)

  log.push({ type: "PermissionRequestDecided", callId: `permission/${pending[0]!.key}`, granted: false, reason: "read only" })
  await Effect.runPromise(settleActor(restarted.definition).pipe(Effect.provide(environment)))
  expect(reads).toBe(1)
  expect(writes).toBe(0)
  expect(log.filter(event => event.type === "PackageReturned").map(event => event.result))
    .toEqual(["contents", { error: "read only" }])
  expect(log.findLast(event => event.type === "ToolReturned")?.result)
    .toEqual({ result: { error: "read only" } })
})
