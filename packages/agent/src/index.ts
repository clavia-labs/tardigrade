import { Effect, Layer } from "effect"
import type { Event } from "@flamecast/core/event"
import { Router } from "@flamecast/core/router"
import { Packages, type Package } from "@flamecast/code/packages"
import { jsSandbox, memoryTmp } from "@flamecast/code/defaults"
import { createHost, type Host } from "@flamecast/host/host"
import { agent, type AgentR } from "./turn"
import { Infer } from "./infer"
import type { Action } from "./events"
import { boundaryOf } from "./boundary"
import { agentsPackage } from "./spawn"

// createRlmAgent is the front door: a Recursive Language Model agent, one hosted,
// spawn-capable agent over an
// ambient in-process host (tutorials/rlm-agent.md). No actor exists outside a host (the Erlang-node
// shape); the user brings packages and a mind, the graph is whatever
// their agent's code decides to spawn, and run answers when the ROOT
// settles, however many lanes exist by then.

export interface CreateAgentOptions {
  readonly packages?: ReadonlyArray<Package>
  // The mind: one inference over the trajectory, one action out.
  readonly infer: (trajectory: ReadonlyArray<Event>, key?: string) => Promise<Action>
  // The root lane's history: an agent initialises from a persisted log, because the log is the
  // only state there is. The next run derives from everything here, and work the log still owes
  // settles on the first drive (index.test.ts, "an agent initialises from a log").
  readonly log?: ReadonlyArray<Event>
}

export interface RlmAgent {
  readonly run: (brief: string) => Promise<{ readonly output?: string; readonly error?: string }>
  readonly host: Host
}

const ROOT = "ag.root"

export const createRlmAgent = (options: CreateAgentOptions): RlmAgent => {
  const user = options.packages ?? []
  const infer = Layer.succeed(Infer, {
    react: (trajectory: ReadonlyArray<Event>, key?: string) => Effect.promise(() => options.infer(trajectory, key))
  })
  const tmp = memoryTmp()

  // The layers close over the host and are built per serve, so the
  // spawn package always routes and reads through the live host.
  const layersFor = (lane: string): Layer.Layer<AgentR> => {
    const self = host.self(lane)
    const router = {
      deliver: (address: string, event: Event) => Effect.sync(() => host.deliver(address, event)),
      call: () => Effect.succeed({ error: "escalatable spawns need a binding with synchronous calls" }),
      resume: () => Effect.succeed({ error: "escalatable spawns need a binding with synchronous calls" })
    }
    const spawn = agentsPackage(router, self, (callId) => host.self(`ag.${callId}`), {
      events: (facet: string) => Promise.resolve(host.read(facet))
    })
    const all = [...user, spawn]
    const packages = Layer.succeed(Packages, {
      resolve: (name: string) => all.find((p) => p.name === name),
      list: () => Effect.succeed(all.map((p) => ({ name: p.name, description: p.description })))
    })
    return Layer.mergeAll(packages, jsSandbox, tmp, infer, Layer.succeed(Router, router)) as unknown as Layer.Layer<AgentR>
  }

  // Every ag. lane runs the full turn loop; anything else is a sink.
  const host: Host = createHost<AgentR>({
    principal: "mem",
    actorFor: (lane) => (lane.startsWith("ag.") ? agent : undefined),
    layersFor: layersFor as never
  })

  if (options.log !== undefined && options.log.length > 0) host.seed(ROOT, options.log)

  // Run ids continue past the seeded history, so a resumed agent's new run never wears an id
  // the log already dedups.
  let n = options.log?.length ?? 0
  const run = async (brief: string): Promise<{ readonly output?: string; readonly error?: string }> => {
    const id = `run-${n++}`
    host.deliver(host.self(ROOT), { type: "MessageReceived", id, text: brief, at: n } as Event)
    await host.drive()
    const boundary = boundaryOf(host.read(ROOT), id)
    if (boundary === undefined) return { error: "the root never settled" }
    if (boundary.kind === "completed") return { output: boundary.output }
    if (boundary.kind === "failed") return { error: boundary.error }
    return { error: "the root parked on a budget ask with nobody to answer" }
  }

  return { run, host }
}
