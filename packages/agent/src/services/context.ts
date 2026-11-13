import { Effect } from "effect"
import { libraryContextSources, resolveLibraryContext, type LibraryBinding, type LibraryContextSource } from "@clavia/tardigrade-libraries"
import { ResolveContext } from "../contracts/acts"
import type { ContextConfiguration } from "../contracts/context"

// contextConfiguration retains static sources and identifies declarations requiring resolution.
export function contextConfiguration(system: LibraryContextSource<unknown, unknown>, libraries: readonly LibraryBinding[]): ContextConfiguration {
  const sources = libraryContextSources(libraries)
  return {
    system: typeof system === "string" ? system : undefined,
    dynamic: typeof system !== "string" || sources.some(source => Effect.isEffect(source.system) || Effect.isEffect(source.user)),
    contributions: sources.map(source => ({
      library: source.library,
      ...(typeof source.system === "string" ? { system: source.system } : {}),
      ...(typeof source.user === "string" ? { user: source.user } : {}),
    })),
  }
}

function isPromptEffect<Source extends LibraryContextSource<unknown, unknown>>(source: Source): source is Extract<Source, Effect.Effect<string, unknown, unknown>> & Effect.Effect<string, Effect.Error<Source>, Effect.Services<Source>> {
  return Effect.isEffect(source)
}

// contextServices binds actor and library prompt effects to the durable resolution act.
export function contextServices<const Source extends LibraryContextSource<unknown, unknown>, const L extends readonly LibraryBinding[]>(system: Source, libraries: L) {
  const dynamicSystem = isPromptEffect(system) ? system : Effect.void
  return ResolveContext.layer(() => Effect.gen(function* () {
    const resolvedSystem = yield* dynamicSystem
    const contributions = yield* resolveLibraryContext(libraries)
    return { ...(resolvedSystem === undefined ? {} : { system: resolvedSystem }), contributions }
  }).pipe(Effect.mapError(String)))
}
