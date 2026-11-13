import type { PromptContent } from "@clavia/tardigrade-model/prompt"
import { Effect } from "effect"
import { libraryContextSources, resolveLibraryContext, type LibraryBinding, type LibraryContextSource } from "@clavia/tardigrade-libraries"
import { ResolveContext } from "../contracts/acts"
import type { ContextConfiguration } from "../contracts/context"

// contextConfiguration retains static sources and identifies declarations requiring resolution.
export function contextConfiguration(system: LibraryContextSource<unknown, unknown>, libraries: readonly LibraryBinding[]): ContextConfiguration {
  const sources = libraryContextSources(libraries)
  const statics = (slot: "system" | "user") => sources.flatMap(source => {
    const content = source[slot]
    return content == null ? [] : [{ library: source.library, content: Effect.isEffect(content) ? "" : content }]
  })
  return {
    dynamic: Effect.isEffect(system) || sources.some(source => Effect.isEffect(source.system) || Effect.isEffect(source.user)),
    system: { ...(Effect.isEffect(system) ? {} : { actor: system }), libraries: statics("system") },
    user: { libraries: statics("user") },
  }
}

function isPromptEffect<Source extends LibraryContextSource<unknown, unknown>>(source: Source): source is Extract<Source, Effect.Effect<PromptContent, unknown, unknown>> & Effect.Effect<PromptContent, Effect.Error<Source>, Effect.Services<Source>> {
  return Effect.isEffect(source)
}

// contextServices binds actor and library prompt effects to the durable resolution act.
export function contextServices<const Source extends LibraryContextSource<unknown, unknown>, const L extends readonly LibraryBinding[]>(system: Source, libraries: L) {
  const dynamicSystem = isPromptEffect(system) ? system : Effect.void
  return ResolveContext.layer(() => Effect.gen(function* () {
    const resolvedSystem = yield* dynamicSystem
    const resolvedLibraries = yield* resolveLibraryContext(libraries)
    return {
      ...resolvedLibraries,
      system: { ...resolvedLibraries.system, ...(resolvedSystem === undefined ? {} : { actor: resolvedSystem }) },
    }
  }).pipe(Effect.mapError(String)))
}
