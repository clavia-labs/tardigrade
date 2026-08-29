import { Effect, Layer } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import type { Event } from "@clavia/tardigrade-core/log/event"
import type { Actor } from "@clavia/tardigrade-core/actor"
import { jsSandboxFor } from "@clavia/tardigrade-code/sandbox/defaults"
import { createHost, type Host, type HostOptions, type ThreadEnv } from "@clavia/tardigrade-host/host"
import {
  boundaryOf,
  Infer,
  NativeOutputSupport,
  type AgentR,
  type InferRequest
} from "tardie"
import type { Action } from "tardie/log/events"

export const ROOT_THREAD = "ag.root"
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
  readonly enqueue: (brief: string) => string
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
    actorFor: (thread: string) => thread.startsWith("ag.") ? assembled : undefined,
    layersFor,
    keyOf: assembled.keyOf,
    ...(options.pick === undefined ? {} : { pick: options.pick }),
    ...(options.driver === undefined ? {} : { driver: options.driver })
  })

  let sequence = 0
  const enqueue = (brief: string): string => {
    const turn = `run-${sequence++}`
    host.commitRoot(host.self(ROOT_THREAD), {
      type: "MessageReceived",
      id: turn,
      text: brief,
      at: sequence
    } as Event)
    return turn
  }
  const result = (turn: string) => {
    const boundary = boundaryOf(host.read(ROOT_THREAD), turn)
    if (boundary?.kind === "completed") return { turn, output: boundary.output }
    if (boundary?.kind === "failed") return { turn, error: boundary.error }
    return { turn, error: "the root did not reach a terminal boundary" }
  }
  const drive = (): Promise<void> => host.drive()
  const run = async (brief: string) => {
    const turn = enqueue(brief)
    await drive()
    return result(turn)
  }

  return { host, enqueue, drive, result, run }
}
