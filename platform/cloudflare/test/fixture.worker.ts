import { Context, Effect, Encoding, Layer, Schema } from "effect"
import { actor, actorMethod } from "tardie"
import { modelAdapters } from "@clavia/tardigrade-model/adapter"
import { openAICompatibleAdapter } from "@clavia/tardigrade-model/openai"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { effect } from "@clavia/tardigrade-core/reconciliation"
import {
  ActorDO,
  ThreadDO,
  cloudflareWorker,
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

const echo = actorMethod({
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.String,
  event: ({ id, input, at }) => ({ type: "EchoRequested", id, text: input.text, at }),
  state: (events, id) => {
    const event = events.find((candidate) =>
      candidate.type === "EchoCompleted" && (candidate as { readonly id?: unknown }).id === id
    ) as { readonly text?: unknown } | undefined
    if (event !== undefined) return { status: "completed" as const, output: String(event.text) }
    return events.some((candidate) =>
      candidate.type === "EchoRequested" && (candidate as { readonly id?: unknown }).id === id
    ) ? { status: "pending" as const } : undefined
  }
})

const worker = cloudflareWorker(actor({
  name: "echo",
  methods: { echo },
  components: [{
    name: "echo",
    keys: {
      prefixes: ["echo-request:", "echo-complete:", "indexed-record:"],
      keyOf: (event) => {
        const id = String((event as { readonly id?: unknown }).id)
        if (event.type === "EchoRequested") return `echo-request:${id}`
        if (event.type === "EchoCompleted") return `echo-complete:${id}`
        if (event.type === "IndexedRecord") return `indexed-record:${String((event as { readonly secretId?: unknown }).secretId)}`
        return undefined
      }
    },
    derive: (events) => ({ view: undefined, transitions: events.flatMap((event) => {
      if (event.type !== "EchoRequested") return []
      const request = event as { readonly id?: unknown; readonly text?: unknown }
      const id = String(request.id)
      if (events.some((candidate) =>
        candidate.type === "EchoCompleted" && (candidate as { readonly id?: unknown }).id === id
      )) return []
      return [effect({
        key: `echo-complete:${id}`,
        input: { id, text: String(request.text) },
        act: (input) => Effect.gen(function* () {
          const application = yield* ThreadApplication
          application.calls += 1
          yield* Effect.promise(() => scheduler.wait(50))
          return [{ type: "EchoCompleted", ...input, text: `${application.prefix}:${application.thread}:${application.calls}:${input.text}` }]
        })
      })]
    }) })
  }]
}), {
  modelAdapters: modelAdapters(openAICompatibleAdapter),
  modelScope: {
    source: "models.dev",
    revision: "workers-bundled-test",
    refreshedAt: 1,
    status: "cached",
    providers: [{
      id: "openai",
      name: "OpenAI",
      env: ["OPENAI_API_KEY"],
      models: [{ id: "gpt-test", metadata: { contextWindowTokens: 128_000 } }]
    }]
  },
  layersFor: ({ env, thread }: CloudflareWorkerLayerContext<FixtureEnv>) =>
    Layer.succeed(ThreadApplication, { prefix: env.APPLICATION_PREFIX, thread, calls: 0 }),
  storeFor: ({ thread }) => thread === "ag.sealed"
    ? {
        codec: encryptedEventCodec(thread, keyFor()),
        indexKey: hmacSha256EventKeyIndex(indexKeyFor(), thread)
      }
    : { codec: plaintextEventCodec, indexKey: plaintextEventKeyIndex }
})

export { ActorDO, ThreadDO }
export default worker
