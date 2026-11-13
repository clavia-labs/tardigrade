import { Effect, Option, Sink, Stream } from "effect"
import { Mime } from "effect/http"
import type { ObjectStorage } from "@clavia/tardigrade-store"
import type { InputContentPart } from "@clavia/tardigrade-model/object/content"
import { WorkspaceError } from "./backend"

export type WorkspaceFileContent = Extract<InputContentPart, { type: "file" }> & { readonly filename: string; readonly byteSize: number }
export type WorkspaceReadResult = string | WorkspaceFileContent

export interface WorkspaceReadRange {
  readonly offset?: number
  readonly limit?: number
}

export interface WorkspaceReadPolicy {
  readonly maxInlineBytes: number
  readonly maxFileBytes: number
  readonly chunkBytes: number
}

export const DEFAULT_WORKSPACE_READ_POLICY: WorkspaceReadPolicy = { maxInlineBytes: 1024 * 1024, maxFileBytes: Number.MAX_SAFE_INTEGER, chunkBytes: 64 * 1024 }
export interface WorkspaceReadOptions {
  readonly contentStore?: typeof ObjectStorage.Service
  readonly fileDelivery?: "auto" | "inline" | "reference"
  readonly readPolicy?: Partial<WorkspaceReadPolicy>
}

// workspaceReadPolicy validates the resource bounds applied to automatic file reads.
export function workspaceReadPolicy(options: Partial<WorkspaceReadPolicy> = {}): WorkspaceReadPolicy {
  const policy = { ...DEFAULT_WORKSPACE_READ_POLICY, ...options }
  for (const [name, value] of Object.entries(policy)) {
    const minimum = name === "chunkBytes" ? 1 : 0
    if (!Number.isSafeInteger(value) || value < minimum) throw new WorkspaceError(`${name} must be a safe integer at least ${minimum}`)
  }
  return policy
}

const textMediaType = (type: string) => type.startsWith("text/") || type === "application/json" || type === "application/javascript" || type === "application/xml" || type.startsWith("application/") && (type.endsWith("+json") || type.endsWith("+xml"))

// readWorkspaceContent selects text, inline bytes, or stored file content within the host's read policy.
export function readWorkspaceContent(path: string, source: Stream.Stream<Uint8Array, WorkspaceError>, maxReadChars: number, options: WorkspaceReadOptions = {}, range: WorkspaceReadRange = {}): Effect.Effect<WorkspaceReadResult, WorkspaceError> {
  return Effect.gen(function* () {
    const policy = yield* Effect.try({ try: () => {
      for (const [name, value] of Object.entries(range)) if ((name === "offset" || name === "limit") && value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new WorkspaceError(`${name} must be a positive safe integer`)
      return workspaceReadPolicy(options.readPolicy)
    }, catch: WorkspaceError.from })
    const delivery = options.fileDelivery ?? "auto"
    if (!["auto", "inline", "reference"].includes(delivery)) return yield* Effect.fail(new WorkspaceError("fileDelivery must be auto, inline, or reference"))
    const filename = path.replaceAll("\\", "/").split("/").at(-1) || path
    const mediaType = Option.getOrElse(Mime.getType(filename), () => "text/plain")
    const body = source.pipe(Stream.flatMap(bytes => Stream.fromIterable(function* () {
      for (let offset = 0; offset < bytes.byteLength; offset += policy.chunkBytes) yield bytes.subarray(offset, offset + policy.chunkBytes)
    }())))
    if (textMediaType(mediaType)) return yield* readWorkspaceText(body, maxReadChars, range)
    const reference = delivery === "reference" || delivery === "auto" && options.contentStore !== undefined
    if (reference && !options.contentStore) return yield* Effect.fail(new WorkspaceError("File reference delivery requires a contentStore"))
    if (reference && options.contentStore?.putStream) {
      const stored = yield* options.contentStore.putStream(body, { maxObjectBytes: policy.maxFileBytes }).pipe(Effect.mapError(WorkspaceError.from))
      return { type: "file", filename, mediaType, byteSize: stored.byteSize, object: stored.object }
    }
    const limit = Math.min(policy.maxInlineBytes, policy.maxFileBytes)
    let byteSize = 0
    const chunks = yield* Stream.runCollect(body.pipe(Stream.mapEffect(bytes => {
      if (bytes.byteLength > limit - byteSize) return Effect.fail(new WorkspaceError(`File exceeds the buffered read limit ${limit} bytes; configure a streaming contentStore or increase the read policy`))
      byteSize += bytes.byteLength
      return Effect.succeed(bytes.slice())
    })))
    const bytes = new Uint8Array(byteSize)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    if (reference) {
      const object = yield* options.contentStore!.put(bytes).pipe(Effect.mapError(WorkspaceError.from))
      return { type: "file", filename, mediaType, byteSize, object }
    }
    return { type: "file", filename, mediaType, byteSize, bytes }
  })
}

// readWorkspaceText selects one-based text lines without buffering skipped lines or a complete long line.
function readWorkspaceText(source: Stream.Stream<Uint8Array, WorkspaceError>, maxReadChars: number, range: WorkspaceReadRange) {
  return Effect.gen(function* () {
    const offset = range.offset ?? 1
    const decoder = new TextDecoder("utf-8", { fatal: true })
    const decode = (bytes?: Uint8Array) => Effect.try({ try: () => bytes ? decoder.decode(bytes, { stream: true }) : decoder.decode(), catch: WorkspaceError.from })
    const decoded = Stream.concat(source.pipe(Stream.mapEffect(decode)), Stream.fromEffect(decode()))
    const result = yield* Stream.run(decoded, Sink.fold(
      () => ({ text: "", line: 1, lastLine: 0, selected: false, endedWithNewline: false, done: false, truncated: false, more: false }),
      state => !state.done,
      (state, chunk: string) => Effect.sync(() => {
        let cursor = 0
        while (cursor < chunk.length && !state.done) {
          if (state.line >= offset && range.limit !== undefined && state.line - offset >= range.limit) {
            state.more = true
            state.done = true
            break
          }
          const newline = chunk.indexOf("\n", cursor)
          const end = newline === -1 ? chunk.length : newline + 1
          if (state.line >= offset) {
            state.selected = true
            const available = maxReadChars - state.text.length
            state.text += chunk.slice(cursor, Math.min(end, cursor + available))
            if (end - cursor > available) {
              state.truncated = true
              state.done = true
              break
            }
            state.lastLine = state.line
          }
          state.endedWithNewline = newline !== -1
          if (newline !== -1) state.line++
          cursor = end
        }
        return state
      }),
    ))
    if (!result.selected && offset > 1) return yield* Effect.fail(new WorkspaceError(`Offset ${offset} is beyond end of file (${result.line - (result.endedWithNewline ? 1 : 0)} lines)`))
    if (result.truncated) {
      const guidance = result.text.endsWith("\n") ? `Use offset=${result.line} to continue.` : `Line ${result.line} was cut; use offset=${result.line} to reread it or bash to inspect a slice of a long line.`
      return `${result.text}\n[truncated: limit ${maxReadChars} characters. ${guidance}]`
    }
    if (result.more) return `${result.text}\n[Showing lines ${offset}-${result.lastLine} (limit ${range.limit} lines). Use offset=${result.line} to continue.]`
    return result.text
  })
}
