import type { PromptContent } from "@clavia/tardigrade-model/prompt"
import { Effect } from "effect"
import { libraryContextSources, resolveLibraryContext, type LibraryBinding, type LibraryContextSource, type LibraryContextRequirements } from "@clavia/tardigrade-libraries"
import type { ResolvedContext } from "../contracts/events"
import { ResolveContext } from "../contracts/acts"
import { mergeLibraryContexts, type ContextConfiguration } from "../contracts/context"

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
export function contextServices<const Source extends LibraryContextSource<unknown, unknown>, const L extends readonly LibraryBinding[]>(system: Source, libraries: L, options: { readonly recordUserContext?: boolean } = {}) {
  const user = options.recordUserContext ? contextConfiguration(system, libraries).user : undefined
  const dynamicSystem = isPromptEffect(system) ? system : Effect.void
  const resolve: Effect.Effect<typeof ResolvedContext.Type, string, Effect.Services<Source> | LibraryContextRequirements<L[number]>> = Effect.gen(function* () {
    const resolvedSystem = yield* dynamicSystem
    const resolvedLibraries = yield* resolveLibraryContext<L>(libraries)
    return {
      ...resolvedLibraries,
      ...(user ? { user: { libraries: mergeLibraryContexts(user.libraries, resolvedLibraries.user.libraries) } } : {}),
      system: { ...resolvedLibraries.system, ...(resolvedSystem === undefined ? {} : { actor: resolvedSystem }) },
    }
  }).pipe(Effect.mapError(String))
  return ResolveContext.layer(() => resolve)
}
