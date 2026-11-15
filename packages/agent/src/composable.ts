import { Effect, Layer } from "effect"
import { atom, type Atom, type ActorMethods, type ActorOutput, type ActService } from "@clavia/tardigrade-core"
import type { LibraryBinding, LibraryContextSource } from "@clavia/tardigrade-libraries"
import { ToolCatalog } from "./actor/context"
import { mergeAgentMethods } from "./actor/methods"
import { prepareContext } from "./atoms/context"
import { infer, type ContextView } from "./atoms/infer"
import { tools as libraryTools, withPermissions as permittedTools, withBudget as budgetedTools, type Tools } from "./atoms/tools"
import { messagesWithContext } from "./atoms/durable/trajectory"
import type { PermissionState } from "./atoms/durable/permissions"
import type { Event } from "./contracts/events"
import type { ToolBudgetView } from "./atoms/budget-request"
import { libraryCatalog, libraryServices } from "./services/tools"
import { contextConfiguration, contextServices } from "./services/context"

export { compact, DEFAULT_COMPACTION_POLICY, type CompactionOptions } from "./atoms/compact"

export const messages = messagesWithContext({ libraries: [] })

export type BoundTools<R, Libraries extends readonly LibraryBinding[]> = Atom<Tools<R>> & { readonly libraries: Libraries }

// tools retains library declarations for the runtime assembled by make.
export function tools<const Libraries extends readonly LibraryBinding[]>(libraries: Libraries) {
  return libraryTools(libraries).pipe(
    Effect.provideService(ToolCatalog, libraryCatalog(libraries)),
    Effect.map(value => Object.assign(value, { libraries })),
  )
}

// withPermissions retains runtime declarations while governing tool proposals.
export function withPermissions<R, P, const Libraries extends readonly LibraryBinding[]>(tools: BoundTools<R, Libraries>, permission: Atom<ActorOutput<typeof PermissionState.Type, Event, P>>): BoundTools<R | P, Libraries> {
  return Object.assign(permittedTools<R, P>(tools, permission), { libraries: tools.libraries })
}

// withBudget retains runtime declarations while governing tool proposals.
export function withBudget<R, B, const Libraries extends readonly LibraryBinding[]>(tools: BoundTools<R, Libraries>, budget: Atom<ToolBudgetView<B>>, options: Parameters<typeof budgetedTools>[2] = {}): BoundTools<R | B, Libraries> {
  return Object.assign(budgetedTools<R, B>(tools, budget, options), { libraries: tools.libraries })
}

// make constructs an agent graph and declares its runtime without executing handlers (platform/test/bun/agent-composition.test.ts).
export function make<R, const Libraries extends readonly LibraryBinding[], const Source extends LibraryContextSource<unknown, unknown>, const Methods extends ActorMethods<object> = {}>(options: {
  readonly system: Source
  readonly tools: BoundTools<R, Libraries>
  readonly context: Atom<ContextView>
  readonly methods?: Methods
}) {
  return Effect.gen(function* () {
    const libraries = options.tools.libraries
    const configuration = contextConfiguration(options.system, libraries)
    // configuration records user context in the journal so independent context projections can read it.
    const preparation = prepareContext({ ...configuration, dynamic: configuration.dynamic || configuration.user.libraries.length > 0 })
    const inference = yield* infer<R, Event, ActService<"agent.context.resolve">>(atom(get => ({
      system: "",
      preparation: get(preparation),
      tools: get(options.tools),
      context: get(options.context),
    })))
    return {
      atom: inference,
      methods: mergeAgentMethods(options.methods),
      layer: Layer.merge(libraryServices(libraries), contextServices(options.system, libraries, { recordUserContext: true })),
    }
  })
}
