import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { actor } from "@clavia/tardigrade-core/actor"
import type { Event } from "@clavia/tardigrade-core/event"
import { replayProjection } from "@clavia/tardigrade-core/projection"
import { parseThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"
import { definePackage } from "@clavia/tardigrade-code/package/definition"
import { createHost } from "@clavia/tardigrade-host/host"
import { testMachineOf as machineOf } from "../fixtures/component"
import { testInferenceLayer } from "../fixtures/model"
import { agentMethods, infer, outputValidateOnce } from "../src/index"
import { requestPermissionMethod, type PermissionDecision } from "../src/actor/permission"
import { escalate } from "../src/component/escalate/index"
import { permissions } from "../src/component/permissions/index"
import { tools } from "../src/component/tool/index"

// These tests describe permission behavior that a multi-user host needs. A shape marked test-local is a placeholder, so maintainers can choose the public surface. The assertions read only observable outcomes.

const requested = (id: string, action: string): Event => ({
  type: "PermissionRequestReceived", id, request: `call-${id}`, turn: "turn", action, reason: "Needs approval"
})

// Answer is test-local: a decision that also names the person who made it.
type Answer = PermissionDecision & { readonly answerer: string }

const answer = (log: ReadonlyArray<Event>, id: string, decision: Answer, at: number): ReadonlyArray<Event> => {
  const response = replayProjection(machineOf(escalate.authority("permissions", "manual")), log)
    .interactions!.respond(id, decision as PermissionDecision)
  return response === undefined ? [] : response.events(response.input, at)
}

const mentions = (value: unknown, text: string) => JSON.stringify(value ?? null).includes(text)

describe("a decision records who answered", () => {
  test.failing("the committed decision names the answerer", () => {
    const decided = answer([requested("r1", "deploy")], "r1", { granted: true, answerer: "alice" }, 1)
    expect(decided).toMatchObject([{ type: "PermissionRequestDecided", callId: "r1", granted: true }])
    expect(mentions(decided, "alice")).toBe(true)
  })

  test.failing("the governed side can read the answerer of its decision", () => {
    const governed = permissions(tools([definePackage({
      name: "deploy", description: "deploy", methods: { run: () => Effect.succeed("deployed") }
    })]), { request: () => ({ action: "deploy", reason: "Needs approval" }), onDenied: (reason, respond) => respond({ error: reason }) })
    const log: Array<Event> = [
      { type: "MessageReceived", id: "turn", text: "deploy", at: 0 },
      { type: "ToolCalled", turn: "turn", callId: "c1", name: "deploy_run", arguments: {}, at: 1 }
    ]
    const key = replayProjection(machineOf(governed), log).view.permissions[0]!.key
    // The answerer field on this event is test-local.
    log.push({ type: "PermissionRequestDecided", callId: `permission/${key}`, granted: true, answerer: "alice", at: 2 })
    expect(mentions(replayProjection(machineOf(governed), log).view.permissions, "alice")).toBe(true)
  })
})

describe("the first answer wins when several people answer", () => {
  test.failing("two answers made from the same pending view settle as the first one, named", () => {
    const log: Array<Event> = [requested("r1", "deploy")]
    const alice = answer(log, "r1", { granted: true, answerer: "alice" }, 2)
    const bob = answer(log, "r1", { denied: true, reason: "not now", answerer: "bob" }, 3)
    log.push(...alice, ...bob)
    const state = replayProjection(requestPermissionMethod.projection, log)
      .invocationState({ method: "requestPermission", id: "r1", epoch: 0 })
    expect(state).toMatchObject({ status: "completed", output: { granted: true } })
    expect(mentions(state, "alice")).toBe(true)
  })
})

describe("a hook can decide a request from earlier decisions", () => {
  test.failing("a repeat of a granted action is granted without a person, and a new action waits for one", () => {
    // The history argument and the undefined result, which leaves the request to a person, are test-local.
    const decide = (request: { readonly action: string }, history?: ReadonlyArray<{ readonly action: string; readonly granted: boolean }>) =>
      history?.some(earlier => earlier.action === request.action && earlier.granted) ? { granted: true as const } : undefined
    const hooked = () => machineOf(escalate.authority("permissions", { decide: decide as never }))

    const first: Array<Event> = [requested("r1", "deploy")]
    const waiting = replayProjection(hooked(), first)
    expect(waiting.transitions).toEqual([])
    expect(waiting.view.pending.map(request => request.id)).toEqual(["r1"])
    first.push(...answer(first, "r1", { granted: true, answerer: "alice" }, 2))

    const log = [...first, requested("r2", "deploy"), requested("r3", "delete")]
    const output = replayProjection(hooked(), log)
    const events = output.transitions.flatMap(work => work.kind === "intent" ? work.events(work.input, 5) : [])
    expect(events).toMatchObject([{ type: "PermissionRequestDecided", callId: "r2", granted: true }])
    expect(replayProjection(hooked(), [...log, ...events]).view.pending.map(request => request.id)).toEqual(["r3"])
  })
})

describe("a denial can fail the turn", () => {
  test.failing("onDenied ends the turn as failed and the model is not called again", async () => {
    let modelCalls = 0
    let writes = 0
    const files = definePackage({
      name: "files", description: "files", methods: { write: () => Effect.sync(() => { writes++; return "written" }) }
    })
    const governed = permissions(tools([files]), {
      request: () => ({ action: "write", reason: "Needs approval" }),
      // The fifth argument is test-local: a way to end the turn instead of returning a tool result.
      onDenied: ((reason: string, _respond: unknown, _work: unknown, _view: unknown, turn?: { readonly fail?: (reason: string) => unknown }) =>
        turn?.fail?.(reason)) as never
    })
    const host = createHost({
      actorName: "deny-fails-turn",
      actorFor: () => actor({ name: "deny-fails-turn", methods: agentMethods, components: [infer([governed, outputValidateOnce], {
        models: { default: { provider: "test", model_id: "fixture" }, allow: "*" }
      })] }),
      layersFor: () => Layer.mergeAll(KeyValueStore.layerMemory, testInferenceLayer({
        react: () => Effect.sync(() => {
          modelCalls++
          return { kind: "calls" as const, calls: [{ callId: `write-${modelCalls}`, name: "files_write", arguments: {} }] }
        })
      }))
    })
    await host.allocate({ kind: "root", coordinate: parseThreadAddress(host.self("root")) })
    await host.commitRoot(host.self("root"), { type: "MessageReceived", id: "m1", text: "write", at: 1 })
    await host.drive()
    expect(modelCalls).toBe(1)
    const key = replayProjection(machineOf(governed), host.read("root")).view.permissions[0]!.key
    host.seed("root", [{ type: "PermissionRequestDecided", callId: `permission/${key}`, granted: false, reason: "Denied by alice", at: 5 }])
    await host.wake("root")
    await host.drive()
    const log = host.read("root")
    expect(writes).toBe(0)
    expect(modelCalls).toBe(1)
    expect(log.filter(event => event.type === "TurnFailed")).toHaveLength(1)
    expect(mentions(log.find(event => event.type === "TurnFailed"), "Denied by alice")).toBe(true)
  })
})
