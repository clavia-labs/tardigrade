import { Context, Effect, Encoding } from "effect"
import type { Event } from "../event"

export interface StoredImage {
  readonly bytes: Uint8Array
  readonly mediaType: string
}

// ImageStore holds image bytes for every thread that can exchange its references.
export class ImageStore extends Context.Service<
  ImageStore,
  {
    readonly egress: "resolve" | "defer"
    readonly put: (image: StoredImage) => Effect.Effect<string>
    readonly get: (reference: string) => Effect.Effect<StoredImage | undefined>
    readonly owns: (reference: string) => boolean
  }
>()("tardigrade/ImageStore") {}

export interface ImageInputPolicy {
  readonly maxBytes: number
  readonly maxTotalBytes: number
}

export const DEFAULT_IMAGE_INPUT_POLICY: ImageInputPolicy = {
  maxBytes: 20 * 1024 * 1024,
  maxTotalBytes: 40 * 1024 * 1024
}

export const imageInputPolicyOf = (policy: Partial<ImageInputPolicy> = {}): ImageInputPolicy => {
  const maxBytes = policy.maxBytes ?? DEFAULT_IMAGE_INPUT_POLICY.maxBytes
  const maxTotalBytes = policy.maxTotalBytes ?? DEFAULT_IMAGE_INPUT_POLICY.maxTotalBytes
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("image maxBytes must be a positive safe integer")
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes <= 0) {
    throw new Error("image maxTotalBytes must be a positive safe integer")
  }
  return { maxBytes, maxTotalBytes }
}

interface InlineImage {
  readonly source: string
  readonly mediaType: string
  readonly encoded: string
  readonly decodedBytes: number
}

const inlineImageOf = (source: string, policy: ImageInputPolicy): InlineImage | undefined => {
  if (!source.startsWith("data:")) return undefined
  const matched = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(source)
  if (matched === null || !matched[1]!.toLowerCase().startsWith("image/")) {
    throw new Error("input_image data URLs must contain base64-encoded image bytes")
  }
  const encoded = matched[2]!
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0
  const decodedBytes = Math.floor(encoded.length * 3 / 4) - padding
  if (decodedBytes > policy.maxBytes) {
    throw new Error(`input_image is ${decodedBytes} bytes, above the ${policy.maxBytes}-byte limit`)
  }
  return { source, mediaType: matched[1]!.toLowerCase(), encoded, decodedBytes }
}

const contentOf = (value: unknown): ReadonlyArray<unknown> | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const content = (value as { readonly content?: unknown }).content
  return Array.isArray(content) ? content : undefined
}

const eventContentOf = (event: Event): ReadonlyArray<unknown> | undefined => {
  if (event.type === "MessageReceived") return contentOf(event)
  if (event.type === "CallPlanned" || event.type === "CallDispatched") {
    if ((event as { readonly method?: unknown }).method !== "message") return undefined
    return contentOf((event as { readonly input?: unknown }).input)
  }
  return undefined
}

const inlineImagesOf = (events: ReadonlyArray<Event>, policy: ImageInputPolicy): ReadonlyArray<InlineImage> => {
  const images: InlineImage[] = []
  const sources = new Map<string, InlineImage>()
  let totalBytes = 0
  for (const event of events) {
    for (const part of eventContentOf(event) ?? []) {
      if (part === null || typeof part !== "object" || Array.isArray(part)) continue
      const candidate = part as { readonly type?: unknown; readonly image_url?: unknown }
      if (candidate.type !== "input_image" || typeof candidate.image_url !== "string") continue
      const image = sources.get(candidate.image_url) ?? inlineImageOf(candidate.image_url, policy)
      if (image === undefined) continue
      totalBytes += image.decodedBytes
      if (totalBytes > policy.maxTotalBytes) {
        throw new Error(`input_image batch is ${totalBytes} bytes, above the ${policy.maxTotalBytes}-byte total limit`)
      }
      if (sources.has(image.source)) continue
      sources.set(image.source, image)
      images.push(image)
    }
  }
  for (const image of images) {
      const decoded = Encoding.decodeBase64(image.encoded)
      if (decoded._tag === "Failure") throw new Error("input_image contains invalid base64 image bytes")
      if (decoded.success.byteLength === 0 || Encoding.encodeBase64(decoded.success) !== image.encoded) {
        throw new Error("input_image contains non-canonical base64 image bytes")
      }
  }
  return images
}

const replaceContent = (event: Event, references: ReadonlyMap<string, string>): Event => {
  const content = eventContentOf(event)
  if (content === undefined) return event
  const replaced = content.map((part) => {
    if (part === null || typeof part !== "object" || Array.isArray(part)) return part
    const candidate = part as { readonly type?: unknown; readonly image_url?: unknown }
    if (candidate.type !== "input_image" || typeof candidate.image_url !== "string") return part
    const reference = references.get(candidate.image_url)
    return reference === undefined ? part : { ...part, image_url: reference }
  })
  if (event.type === "MessageReceived") return { ...event, content: replaced }
  const input = (event as unknown as { readonly input: Readonly<Record<string, unknown>> }).input
  return { ...event, input: { ...input, content: replaced } }
}

// storeEventImages stores every inline image before returning events that are safe to append.
export const storeEventImages = (
  events: ReadonlyArray<Event>,
  store: Context.Service.Shape<typeof ImageStore>,
  options: Partial<ImageInputPolicy> = {}
): Effect.Effect<ReadonlyArray<Event>> => Effect.gen(function* () {
  const policy = imageInputPolicyOf(options)
  const images = inlineImagesOf(events, policy)
  if (images.length === 0) return events
  const references = new Map<string, string>()
  for (const inline of images) {
    const decoded = Encoding.decodeBase64(inline.encoded)
    if (decoded._tag === "Failure") return yield* Effect.die(new Error("validated input_image could not be decoded"))
    const reference = yield* store.put({ bytes: decoded.success, mediaType: inline.mediaType })
    if (reference.startsWith("data:") || !store.owns(reference)) {
      return yield* Effect.die(new Error("ImageStore.put must return an owned durable reference"))
    }
    references.set(inline.source, reference)
  }
  return events.map((event) => replaceContent(event, references))
})

// resolveImageSource returns a data URL for a reference owned by the configured store.
export const resolveImageSource = (
  source: string,
  store: Context.Service.Shape<typeof ImageStore>
): Effect.Effect<string> => {
  if (!store.owns(source)) return Effect.succeed(source)
  return Effect.flatMap(store.get(source), (image) => image === undefined
    ? Effect.die(new Error(`stored image ${JSON.stringify(source)} does not exist`))
    : Effect.succeed(`data:${image.mediaType};base64,${Encoding.encodeBase64(image.bytes)}`))
}
