import { bindTransitionContext } from "@clavia/tardigrade-core/transition/transition"
import { Context, Effect, Encoding, Layer, Schema } from "effect"
import { actor, actorMethod, component } from "@clavia/tardigrade-core/actor"
import { allocateRootThread } from "@clavia/tardigrade-core/actor"
import type { Event } from "@clavia/tardigrade-core/log/event"
import {
  ActorDO,
  ThreadDO,
  createWorker,
  type CloudflareWorkerLayerContext,
  type Env
} from "../src/worker"
import {
  hmacSha256EventKeyIndex,
  plaintextEventCodec,
  plaintextEventKeyIndex,
  type CloudflareEventCodec
} from "../src/storage"

interface FixtureEnv extends Env {
  readonly APPLICATION_PREFIX: string
  readonly CATALOG_MIGRATION: string
}

class ThreadApplication extends Context.Service<
  ThreadApplication,
  { readonly prefix: string; readonly thread: string; calls: number }
>()("test/ThreadApplication") {}

const keyFor = (): Promise<CryptoKey> => crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode("0123456789abcdef0123456789abcdef"),
  { name: "AES-GCM" },
  false,
  ["encrypt", "decrypt"]
)

const indexKeyFor = (): Promise<CryptoKey> => crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode("abcdef0123456789abcdef0123456789"),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"]
)

const identityOf = (event: Event): { readonly type: string; readonly id?: unknown; readonly callId?: unknown } => {
  const value = event as { readonly id?: unknown; readonly callId?: unknown }
  return {
    type: event.type,
    ...(value.id === undefined ? {} : { id: value.id }),
    ...(value.callId === undefined ? {} : { callId: value.callId })
  }
}

const seal = async (key: CryptoKey, thread: string, event: Event): Promise<Event> => {
  const identity = identityOf(event)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify({ binding: { thread, ...identity }, event }))
  )
  return {
    ...identity,
    iv: Encoding.encodeBase64(iv),
    ciphertext: Encoding.encodeBase64(new Uint8Array(ciphertext))
  } as Event
}

const decode = (value: unknown, field: string): Uint8Array<ArrayBuffer> => {
  if (typeof value !== "string") throw new Error(`encrypted test store found no ${field}`)
  const decoded = Encoding.decodeBase64(value)
  if (decoded._tag === "Failure") throw new Error(`encrypted test store found invalid ${field}`)
  return Uint8Array.from(decoded.success)
}

const open = async (key: CryptoKey, thread: string, event: Event): Promise<Event> => {
  const value = event as { readonly iv?: unknown; readonly ciphertext?: unknown }
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decode(value.iv, "initialization vector") },
    key,
    decode(value.ciphertext, "ciphertext")
  )
  const opened = JSON.parse(new TextDecoder().decode(plaintext)) as {
    readonly binding?: unknown
    readonly event?: unknown
  }
  const expected = { thread, ...identityOf(event) }
  if (JSON.stringify(opened.binding) !== JSON.stringify(expected)) {
    throw new Error("encrypted test store found mismatched thread or event identity")
  }
  if (typeof opened.event !== "object" || opened.event === null) throw new Error("encrypted test store found no event")
  return opened.event as Event
}

const sealAll = async (key: Promise<CryptoKey>, thread: string, events: ReadonlyArray<Event>): Promise<ReadonlyArray<Event>> => {
  const resolved = await key
  return Promise.all(events.map((event) => seal(resolved, thread, event)))
}

const openAll = async (key: Promise<CryptoKey>, thread: string, events: ReadonlyArray<Event>): Promise<ReadonlyArray<Event>> => {
  const resolved = await key
  return Promise.all(events.map((event) => open(resolved, thread, event)))
}

const encryptedEventCodec = (thread: string, key: Promise<CryptoKey>): CloudflareEventCodec => ({
  encode: (events) => Effect.promise(() => sealAll(key, thread, events)),
  decode: (events) => Effect.promise(() => openAll(key, thread, events))
})

interface EchoState {
  readonly requests: ReadonlyMap<string, Event>
  readonly completions: ReadonlyMap<string, string>
}

const initialEchoState = (): EchoState => ({ requests: new Map(), completions: new Map() })

const stepEchoState = (state: EchoState, event: Event): EchoState => {
  const value = event as { readonly id?: unknown; readonly text?: unknown }
  const id = String(value.id ?? "")
  if (event.type === "EchoRequested") {
    if (state.requests.get(id)?.text === String(value.text ?? "")) return state
    return { ...state, requests: new Map(state.requests).set(id, event) }
  }
  if (event.type === "EchoCompleted") {
    if (state.completions.get(id) === String(value.text ?? "")) return state
    return { ...state, completions: new Map(state.completions).set(id, String(value.text ?? "")) }
  }
  return state
}

const echo = actorMethod({
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.String,
  event: ({ invocation, input, at }) => ({ type: "EchoRequested", id: invocation.id, text: input.text, at }),
  projection: {
    initial: initialEchoState,
    step: stepEchoState,
    output: (state) => ({
      currentEpoch: () => 0,
      invocationState: (invocation) => {
        if (!state.requests.has(invocation.id)) return undefined
        const completed = state.completions.get(invocation.id)
        return completed === undefined
          ? { status: "pending" as const }
          : { status: "completed" as const, output: completed }
      }
    })
  }
})

const { worker } = createWorker(actor({
  name: "echo",
  methods: { echo },
  components: [{ ...component({
    name: "echo",
    initial: initialEchoState,
    step: stepEchoState,
    output: (state) => ({
      view: undefined,
      transitions: [...state.requests].flatMap(([id, event]) => state.completions.has(id) ? [] : [bindTransitionContext(event, "echo").effect("echo", {
        invocation: { method: "echo", id, epoch: 0 },
        input: { id, text: String(event.text ?? "") },
        act: (input) => Effect.gen(function* () {
          if (input.text === "allocate-root") {
            const root = yield* allocateRootThread({ name: "echo", methods: { echo } }, {
              instance: "main", name: "sdk-root"
            })
            const text = yield* root.echo({ text: "hello" }, { key: "root-echo" })
            return [{ type: "EchoCompleted", id: input.id, text }]
          }
          const application = yield* ThreadApplication
          application.calls += 1
          yield* Effect.promise(() => scheduler.wait(50))
          return [{ type: "EchoCompleted", ...input, text: `${application.prefix}:${application.thread}:${application.calls}:${input.text}` }]
        }).pipe(Effect.orDie)
      })])
    })
  }), keys: { prefixes: ["indexed-record:"], keyOf: (event: Event) => event.type === "IndexedRecord" ? `indexed-record:${String(event.secretId)}` : undefined } }]
}), {
  layersFor: ({ env, thread }: CloudflareWorkerLayerContext<FixtureEnv>) =>
    Layer.succeed(ThreadApplication, { prefix: env.APPLICATION_PREFIX, thread, calls: 0 }),
  storeFor: ({ thread }) => thread === "sealed"
    ? {
        codec: encryptedEventCodec(thread, keyFor()),
        indexKey: hmacSha256EventKeyIndex(indexKeyFor(), thread)
      }
    : { codec: plaintextEventCodec, indexKey: plaintextEventKeyIndex }
})

export { ActorDO, ThreadDO }
export default worker
