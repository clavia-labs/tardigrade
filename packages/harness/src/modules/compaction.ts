import { Clock, Effect } from "effect"
import { machine, type Envelope } from "@flamecast/core"
import { checkpointOf, estimateTokens, keepUpTo, suffixOf } from "../context"
import { defineModule } from "../module"
import { environment } from "../providers/environment"
import { transcript } from "../turns"
import { inferenceState } from "./inference"

export const TRIGGER_RATIO = 0.8
export const KEEP_RATIO = 0.2
export const COMPRESSION_RATIO = 0.5

const MORPH_URL = "https://api.morphllm.com/v1"

export interface MorphOptions {
  readonly apiKey?: string | undefined
  readonly apiUrl?: string | undefined
  readonly triggerAt?: number | undefined
  readonly keepAt?: number | undefined
  readonly fireTokens?: number | undefined
  readonly keepTokens?: number | undefined
  readonly compressionRatio?: number | undefined
  readonly fetch?: typeof fetch | undefined
}

export const naiveSummary = (input: string, ratio: number): string => {
  const tidy = input
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
    .join("\n")
  const budget = Math.max(1, Math.floor(input.length * ratio))
  if (tidy.length <= budget) return tidy
  return `${tidy.slice(0, budget)}\n[compaction fallback: ${tidy.length - budget} chars elided; the log keeps the full history]`
}

interface Compacted {
  readonly summary: string
  readonly provider: "morph" | "fallback"
}

const compress = (
  options: MorphOptions,
  input: string,
  query: string,
  ratio: number
): Effect.Effect<Compacted> => {
  const fallback: Compacted = { summary: naiveSummary(input, ratio), provider: "fallback" }
  const apiKey = options.apiKey ?? environment("MORPH_API_KEY")
  if (apiKey === undefined) return Effect.succeed(fallback)
  const call = options.fetch ?? fetch
  return Effect.tryPromise({
    try: async (): Promise<Compacted> => {
      const response = await call(`${options.apiUrl ?? MORPH_URL}/compact`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input,
          query,
          compression_ratio: ratio,
          preserve_recent: 0
        })
      })
      if (!response.ok) throw new Error(`morph compact failed with HTTP ${response.status}`)
      const body = (await response.json()) as { output?: unknown }
      if (typeof body.output !== "string") throw new Error("morph compact returned no output")
      return { summary: body.output, provider: "morph" }
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error)))
  }).pipe(
    Effect.catchAll(() => Effect.succeed(fallback)),
    Effect.catchAllDefect(() => Effect.succeed(fallback))
  )
}

const lastQuestion = (log: ReadonlyArray<Envelope>): string => {
  for (let index = log.length - 1; index >= 0; index--) {
    const event = log[index]
    if (event?.type === "MessageReceived") return String(event.text ?? "")
  }
  return ""
}

export const morphCompaction = (options: MorphOptions = {}) => {
  const triggerAt = options.triggerAt ?? TRIGGER_RATIO
  const keepAt = options.keepAt ?? KEEP_RATIO
  const ratio = options.compressionRatio ?? COMPRESSION_RATIO
  return defineModule({
    id: "compaction",
    version: "2",
    fingerprint: {
      triggerAt,
      keepAt,
      fireTokens: options.fireTokens,
      keepTokens: options.keepTokens,
      ratio,
      apiUrl: options.apiUrl ?? MORPH_URL,
      morph: (options.apiKey ?? environment("MORPH_API_KEY")) !== undefined
    },
    requires: [inferenceState] as const,
    setup: (context) => {
      const thresholds = (log: ReadonlyArray<Envelope>) => {
        const window = context.resolve(inferenceState, log).contextWindow
        return {
          fire: options.fireTokens ?? Math.max(1, Math.floor(window * triggerAt)),
          keep: options.keepTokens ?? Math.max(1, Math.floor(window * keepAt))
        }
      }
      const overContext = (log: ReadonlyArray<Envelope>): boolean =>
        estimateTokens(suffixOf(log)) > thresholds(log).fire
      const compactionMachine = machine({
        id: "compaction",
        initial: "idle",
        states: {
          idle: {
            on: {
              ReplyDelivered: { target: "compacting", when: overContext },
              CompactionFired: "compacting"
            }
          },
          compacting: {
            act: (log) =>
              Effect.gen(function* () {
                const at = yield* Clock.currentTimeMillis
                const prior = checkpointOf(log)
                const upTo = Math.max(prior.upTo, keepUpTo(log, thresholds(log).keep))
                const span = log.slice(prior.upTo, upTo)
                if (span.length === 0) {
                  return [
                    {
                      type: "CompactionCompleted",
                      upTo: prior.upTo,
                      summary: prior.summary,
                      provider: "fallback",
                      at
                    }
                  ]
                }
                const input = [
                  prior.summary === "" ? "" : `Summary so far: ${prior.summary}`,
                  transcript(span)
                ]
                  .filter((part) => part !== "")
                  .join("\n\n")
                const compacted = yield* compress(options, input, lastQuestion(log), ratio)
                return [
                  {
                    type: "CompactionCompleted",
                    upTo,
                    summary: compacted.summary,
                    provider: compacted.provider,
                    at
                  }
                ]
              }),
            on: { CompactionCompleted: "idle" }
          }
        }
      })
      return {
        events: ["CompactionFired", "CompactionCompleted"],
        machines: [compactionMachine]
      }
    }
  })
}
