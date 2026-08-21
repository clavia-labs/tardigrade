import { Effect, Layer } from "effect"
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Infer, type InferRequest } from "tardie"
import type { Action } from "tardie/events"
import type { Event } from "@clavia/tardigrade-core/event"
import { layerConfig, readConfig } from "@clavia/tardigrade-server/config"
import { layerThreads } from "@clavia/tardigrade-server/host"
import { serve } from "@clavia/tardigrade-server/http"

// The development server: the real apps/server process, on a volatile database, with the model seam
// bound to a scripted mind. It is the same seam the server's own tests use
// (apps/server/src/api.test.ts), so the UI develops against real projections, a real driver, and a
// real SSE tail, and needs no model credentials.
//
// Every thread this fixture serves is invented by the script below. Nothing here is imported by the
// app; the app only ever speaks HTTP.

// Where the fixture listens, matching the client's DEFAULT_BASE_URL (packages/client/src/client.ts).
export const FIXTURE_PORT = 4242

// How many children the spawning brief asks for. The forest is worth looking at only when it has a
// shape, and this is the number that gives it one.
export const FIXTURE_FANOUT = 3

// The prefix a brief carries to ask the scripted mind to spawn rather than answer.
export const SPAWN_BRIEF = "spawn "

const briefOf = (trajectory: ReadonlyArray<Event>): string => {
  for (let i = trajectory.length - 1; i >= 0; i--) {
    const event = trajectory[i]!
    if (event.type === "MessageReceived") return String((event as { text?: unknown }).text ?? "")
  }
  return ""
}

// The scripted mind answers a plain brief in one attempt, and answers a `spawn <name>` brief by
// running one execution that briefs FIXTURE_FANOUT children and reporting what they said. The tool
// call id is the brief's own name, so the children's ids are stated by the caller rather than by a
// counter (packages/agent/src/spawn.ts, `sibling`).
const scripted = ({ trajectory }: InferRequest): Action => {
  const brief = briefOf(trajectory)
  if (!brief.startsWith(SPAWN_BRIEF)) return { kind: "complete", output: `ok: ${brief}` }
  const start = trajectory.reduce((n, event, i) => (event.type === "MessageReceived" ? i : n), 0)
  const returned = trajectory.slice(start).find((event) => event.type === "ToolReturned") as
    | { result?: { result?: unknown } }
    | undefined
  if (returned !== undefined) return { kind: "complete", output: JSON.stringify(returned.result?.result ?? null) }
  return {
    kind: "call",
    callId: brief.slice(SPAWN_BRIEF.length),
    name: "execute",
    arguments: {
      code: `const kids = await Promise.all([${
        Array.from({ length: FIXTURE_FANOUT }, (_, i) => `agents.run({ text: "survey shard ${i + 1}" })`).join(", ")
      }]); return kids.map((k) => k.output);`
    }
  }
}

const layerScripted: Layer.Layer<Infer> = Layer.succeed(Infer)({
  react: (request: InferRequest) => Effect.succeed(scripted(request))
})

// ":memory:" means the run starts empty every time the fixture boots, which is what a development
// loop wants: the forest on screen is the forest this session made.
const config = layerConfig(readConfig({ TARDIGRADE_DB: ":memory:", PORT: String(FIXTURE_PORT) }))

const threads = Layer.provide(layerThreads({ infer: layerScripted }), config)

const app = Layer.provideMerge(serve({ disableLogger: true }), [
  BunHttpServer.layer({ port: FIXTURE_PORT }),
  config,
  threads
])

// The briefs the fixture delivers at boot, so the UI has a forest before anyone types anything. The
// server dedups by message id, so re-running a brief costs nothing (apps/server/src/host.ts).
export const FIXTURE_BRIEFS: ReadonlyArray<{ readonly thread: string; readonly id: string; readonly text: string }> = [
  { thread: "root", id: "m1", text: `${SPAWN_BRIEF}survey` },
  { thread: "root", id: "m2", text: "summarize the survey" },
  { thread: "deriver", id: "m3", text: "derive the shape of the log" }
]

const post = (thread: string, body: unknown) =>
  fetch(`http://127.0.0.1:${FIXTURE_PORT}/v1/actors/default/threads/${encodeURIComponent(thread)}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })

const seed = Effect.promise(async () => {
  for (const { thread, ...message } of FIXTURE_BRIEFS) await post(thread, { type: "MessageReceived", ...message })
}).pipe(
  Effect.tap(() => Effect.log(`fixture: seeded ${FIXTURE_BRIEFS.length} briefs on http://127.0.0.1:${FIXTURE_PORT}`))
)

BunRuntime.runMain(Layer.launch(Layer.effectDiscard(seed).pipe(Layer.provideMerge(app))))
