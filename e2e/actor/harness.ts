import { Effect, Layer, Schema } from "effect"
import { actorRuntimeOf } from "@clavia/tardigrade-core/runtime"
import { KeyValueStore } from "effect/unstable/persistence"
import { ChildCreated } from "@clavia/tardigrade-core/interaction/relations"
import { prepareInvocation } from "@clavia/tardigrade-core/interaction/prepare"
import { formatThreadAddress, parseThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"
import type { Event } from "@clavia/tardigrade-core/log/event"
import type { Actor } from "@clavia/tardigrade-core/actor"
import { jsSandboxFor } from "@clavia/tardigrade-code/sandbox/defaults"
import { createHost, type Host, type HostOptions, type ThreadEnv } from "@clavia/tardigrade-host/host"
import {
  Infer,
  NativeOutputSupport,
  type AgentR,
  type InferRequest
} from "tardie"
import type { Action } from "tardie/log/events"

export const ROOT_THREAD = "ag.root"

// childThreadsOf maps each spawn's call id to the address its ChildCreated recorded. The child's
// address is a fact of the parent log, never a naming convention a test re-derives.
export const childThreadsOf = (root: ReadonlyArray<Event>): ReadonlyMap<string, string> => {
  const threads = new Map<string, string>()
  for (const event of root) {
    if (!Schema.is(ChildCreated)(event)) continue
    threads.set(event.callId, event.address.thread)
  }
  return threads
}

export const TEST_MODEL = {
  models: {
    default: { provider: "test", model_id: "test-model" },
    allow: "*"
  }
} as const

export type Mind = (request: InferRequest, key?: string) => Promise<Action>

type TestR = AgentR | NativeOutputSupport

export interface ActorScenario {
  readonly host: Host
  readonly enqueue: (brief: string) => Promise<string>
  readonly drive: () => Promise<void>
  readonly result: (turn: string) => { readonly turn: string; readonly output?: string; readonly error?: string }
  readonly run: (brief: string) => Promise<{ readonly turn: string; readonly output?: string; readonly error?: string }>
}

export interface ActorScenarioOptions {
  readonly pick?: HostOptions<TestR>["pick"]
  readonly driver?: HostOptions<TestR>["driver"]
}

// actorScenario gives each case a fresh in-process host, store, sandbox, and scripted inference seam.
export const actorScenario = (
  assembled: Actor<TestR>,
  mind: Mind,
  options: ActorScenarioOptions = {}
): ActorScenario => {
  const layersFor = (_thread: string): ThreadEnv<TestR> =>
    Layer.mergeAll(
      KeyValueStore.layerMemory,
      jsSandboxFor({}),
      Layer.succeed(Infer, {
        react: (request: InferRequest, key?: string) => Effect.promise(() => mind(request, key))
      }),
      Layer.succeed(NativeOutputSupport, { withTools: true })
    )
  const host: Host = createHost<TestR>({
    actorName: "mem",
    actorFor: () => assembled,
    layersFor,
    keyOf: actorRuntimeOf(assembled).keyOf,
    ...(options.pick === undefined ? {} : { pick: options.pick }),
    ...(options.driver === undefined ? {} : { driver: options.driver })
  })

  let sequence = 0
  const message = assembled.methods.message
  if (message === undefined) throw new Error("actor scenarios require a message method")
  const enqueue = async (brief: string): Promise<string> => {
    const turn = `run-${sequence++}`
    const target = await host.allocate({ kind: "root", coordinate: parseThreadAddress(host.self(ROOT_THREAD)) })
    const prepared = prepareInvocation({
      reference: { target, invocation: { method: "message", id: turn, epoch: 0 } },
      method: message, input: { text: brief }, at: Date.now()
    })
    await host.commitRoot(formatThreadAddress(target), prepared.event)
    return turn
  }
  const result = (turn: string) => {
    const state = message.state(host.read(ROOT_THREAD), { method: "message", id: turn, epoch: 0 })
    if (state?.status === "completed") return { turn, output: Schema.decodeUnknownSync(Schema.String)(state.output) }
    if (state?.status === "failed") return { turn, error: state.error }
    if (state?.status === "cancelled") return { turn, error: state.reason ?? "cancelled" }
    return { turn, error: "the root did not reach a terminal boundary" }
  }
  const drive = (): Promise<void> => host.drive()
  const run = async (brief: string) => {
    const turn = await enqueue(brief)
    await drive()
    return result(turn)
  }

  return { host, enqueue, drive, result, run }
}
