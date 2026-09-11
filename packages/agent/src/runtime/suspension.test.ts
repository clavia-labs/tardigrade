import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { actor } from "@clavia/tardigrade-core/actor"
import { actorRuntimeOf, InvocationSuspended } from "@clavia/tardigrade-core/runtime"
import { createHost, type Host, type ThreadEnv } from "@clavia/tardigrade-host/host"
import type { Action } from "../log/events"
import { testInferenceLayer } from "../testing/inference"
import { NativeOutputSupport } from "../inference/contract"
import { agentMethods, infer, nativeOutput, tool } from "../index"
import type { AgentR } from "./turn"

// A binding whose answer arrives as a later event parks the attempt: it dies with
// InvocationSuspended instead of returning an action. These tests hold the contract that follows
// from that (inference/contract.ts, Infer): one mark spans the wait, a repeated park absorbs,
// waiting never spends the give-up bound, and a cancellation still ends the turn.

const ROOT = "ag.root"
const TURN = "m1"
const TEST_MODEL = { models: { default: { provider: "test", model_id: "test-model" }, allow: "*" } } as const
const OTHER_MODEL = { models: { default: { provider: "test", model_id: "other-model" }, allow: "*" } } as const

type TestR = AgentR | NativeOutputSupport

const assembledFor = (policy: typeof TEST_MODEL | typeof OTHER_MODEL) => actor({
  name: "test-agent",
  methods: agentMethods,
  components: [infer([
    tool({ spec: { name: "read", description: "Read", inputSchema: {} }, run: () => Effect.succeed("read") }),
    nativeOutput
  ], policy)]
})

// Park is the binding under test: it parks every ask until `answers` is set, and counts the asks so
// a test can see how often the transition re-fired.
interface Park {
  answers: boolean
  asks: number
  models?: Array<string | undefined>
}

// hosted binds the assembly to an in-process host whose store honors the actor's own dedup keys, so
// an absorbed append leaves the head unchanged here exactly as it does on a durable platform
// (core/log/service.ts, guarantee 5).
const hosted = (park: Park, policy: typeof TEST_MODEL | typeof OTHER_MODEL = TEST_MODEL): Host => {
  const assembled = assembledFor(policy)
  const layersFor = (_thread: string): ThreadEnv<TestR> =>
    Layer.mergeAll(
      KeyValueStore.layerMemory,
      testInferenceLayer({
        react: (request) => Effect.suspend((): Effect.Effect<Action> => {
          park.asks += 1
          park.models?.push(request.model?.model_id)
          return park.answers
            ? Effect.succeed({ kind: "complete", output: "the answer that arrived later" })
            : Effect.die(new InvocationSuspended("inference:m1/infer/0"))
        })
      }),
      Layer.succeed(NativeOutputSupport, { withTools: true })
    )
  return createHost<TestR>({
    actorName: "mem",
    actorFor: () => assembled,
    keyOf: actorRuntimeOf(assembled).keyOf,
    layersFor
  })
}

const ask = async (host: Host): Promise<void> => {
  await host.commitRoot(host.self(ROOT), { type: "MessageReceived", id: TURN, text: "ask", at: 1 } as Event)
  await host.drive()
}

// wake lands an event the turn's own alphabet does not name, standing for whatever the binding is
// waiting on, and drives. The trailing state of the slice moves, so the transition re-fires and the
// binding is asked about the same attempt.
const wake = async (host: Host, at: number): Promise<void> => {
  host.seed(ROOT, [{ type: "NoteRecorded", turn: TURN, at } as Event])
  await host.wake(ROOT)
}

const types = (host: Host): ReadonlyArray<string> => host.read(ROOT).map((event) => event.type)

describe("a binding that parks an attempt", () => {
  test("one mark spans the wait, and the waking event completes the same attempt", async () => {
    const park: Park = { answers: false, asks: 0 }
    const host = hosted(park)
    await ask(host)
    expect(types(host)).toEqual(["ThreadCreated", "MessageReceived", "ModelCalled", "ModelCallSuspended"])
    park.answers = true
    await wake(host, 5)
    expect(types(host)).toEqual([
      "ThreadCreated",
      "MessageReceived",
      "ModelCalled",
      "ModelCallSuspended",
      "NoteRecorded",
      "ModelReturned",
      "TurnCompleted"
    ])
    const log = host.read(ROOT)
    expect(log.find((event) => event.type === "ModelCalled")).toMatchObject({ callId: "m1/infer/0", ordinal: 0 })
    expect(log.find((event) => event.type === "ModelCallSuspended"))
      .toMatchObject({ callId: "m1/infer/0", ordinal: 0, awaiting: "inference:m1/infer/0", turn: TURN })
    expect(log.find((event) => event.type === "ModelReturned")).toMatchObject({ callId: "m1/infer/0", ordinal: 0 })
    expect(log.find((event) => event.type === "TurnCompleted"))
      .toMatchObject({ attemptKey: "m1/infer/0", output: "the answer that arrived later" })
  })

  test("a repeated park absorbs and leaves the transition blocked", async () => {
    const park: Park = { answers: false, asks: 0 }
    const host = hosted(park)
    await ask(host)
    // Recording the park moves the log, so the settlement re-derives and asks once more on the new
    // trailing state. That second park lands on the key the first took, nothing moves, and the
    // transition is reported blocked rather than wedged (core/runtime/reconciler.ts, fire).
    expect(park.asks).toBe(2)
    expect(host.read(ROOT).filter((event) => event.type === "ModelCallSuspended")).toHaveLength(1)
    await host.wake(ROOT)
    expect(host.read(ROOT).filter((event) => event.type === "ModelCallSuspended")).toHaveLength(1)
    expect(host.read(ROOT).filter((event) => event.type === "ModelCalled")).toHaveLength(1)
  })

  test("a reconstructed host resumes from the recorded awaited key", async () => {
    const park: Park = { answers: false, asks: 0, models: [] }
    const first = hosted(park)
    await ask(first)
    const retained = first.read(ROOT)
    expect(retained.find((event) => event.type === "ModelCallSuspended"))
      .toMatchObject({ awaiting: "inference:m1/infer/0" })

    park.answers = true
    const reconstructed = hosted(park, OTHER_MODEL)
    reconstructed.seed(ROOT, retained)
    reconstructed.seed(ROOT, [{
      type: "OperationCompleted",
      id: "inference:m1/infer/0",
      turn: TURN,
      at: 5
    } as Event])
    await reconstructed.wake(ROOT)

    const log = reconstructed.read(ROOT)
    expect(log.filter((event) => event.type === "ModelCalled")).toHaveLength(1)
    expect(log.find((event) => event.type === "ModelReturned"))
      .toMatchObject({ callId: "m1/infer/0", ordinal: 0 })
    expect(log.find((event) => event.type === "TurnCompleted"))
      .toMatchObject({ output: "the answer that arrived later" })
    expect(park.models).toEqual(["test-model", "test-model", "test-model"])
  })

  test("parking three times never spends the give-up bound", async () => {
    // DEFAULT_INFER_POLICY.giveUpAfter is 3. A park is not a died attempt: the mark's own
    // ModelCallSuspended is a committed event after it, so the count stays at zero however long the
    // wait runs (inference/machine.ts, diedAttempts).
    const park: Park = { answers: false, asks: 0 }
    const host = hosted(park)
    await ask(host)
    for (const at of [5, 6, 7]) await wake(host, at)
    expect(host.read(ROOT).some((event) => event.type === "TurnFailed")).toBe(false)
    park.answers = true
    await wake(host, 8)
    const log = host.read(ROOT)
    expect(log.filter((event) => event.type === "ModelCalled")).toHaveLength(1)
    expect(log.filter((event) => event.type === "ModelCallSuspended")).toHaveLength(1)
    expect(log.findLast((event) => event.type === "TurnCompleted"))
      .toMatchObject({ output: "the answer that arrived later" })
  })

  test("cancelling a parked attempt ends the turn and asks the binding nothing more", async () => {
    const park: Park = { answers: false, asks: 0 }
    const host = hosted(park)
    await ask(host)
    const asked = park.asks
    await host.commitRoot(host.self(ROOT), {
      type: "CancellationRequested",
      request: "x1",
      invocation: { method: "message", id: TURN, epoch: 0 },
      cause: "requested",
      reason: "operator stopped it",
      at: 6
    } as Event)
    await host.drive()
    const log = host.read(ROOT)
    expect(log.filter((event) => event.type === "TurnCancelled"))
      .toEqual([expect.objectContaining({ request: "x1", turn: TURN })])
    expect(log.some((event) => event.type === "TurnCompleted")).toBe(false)
    expect(park.asks).toBe(asked)
  })
})
