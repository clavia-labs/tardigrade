import { Context, Effect } from "effect"
import type { Directory } from "./directory"
import type { RoutedEnvelope } from "./envelope"
import type { Transport } from "./transport"

// TransportRoute resolves one envelope to a named transport invocation.
export interface TransportRoute {
  readonly transport: string
  readonly resolve: (envelope: RoutedEnvelope) => Effect.Effect<(() => Effect.Effect<void>) | undefined>
}

// directoryRoute binds a logical directory to one transport while keeping its destination type inside the route.
export const directoryRoute = <Identity, Destination, E extends RoutedEnvelope>(
  transport: Transport<Destination, E>,
  directory: Directory<Identity, Destination>,
  accepts: (envelope: RoutedEnvelope) => envelope is E,
  identityOf: (envelope: E) => Identity
): TransportRoute => ({
  transport: transport.name,
  resolve: (envelope) =>
    accepts(envelope)
      ? directory.resolve(identityOf(envelope)).pipe(
          Effect.map((destination) => destination === undefined ? undefined : () => transport.send(destination, envelope))
        )
      : Effect.as(Effect.void, undefined)
})

// sendThrough resolves through exactly one transport. Missing and overlapping routes die before sending begins (router.test.ts, "a missing route refuses the envelope" and "overlapping routes refuse before either transport sends").
export const sendThrough = (
  routes: ReadonlyArray<TransportRoute>,
  envelope: RoutedEnvelope
): Effect.Effect<void> =>
  Effect.forEach(routes, (route) =>
    route.resolve(envelope).pipe(
      Effect.map((send) => send === undefined ? undefined : { transport: route.transport, send })
    )
  ).pipe(
    Effect.map((resolved) => resolved.filter((match) => match !== undefined)),
    Effect.flatMap((matches) => {
      if (matches.length === 0) {
        return Effect.die(new Error(`no transport accepts target ${JSON.stringify(envelope.link.target)}`))
      }
      if (matches.length > 1) {
        return Effect.die(new Error(`multiple transports accept target ${JSON.stringify(envelope.link.target)}: ${matches.map((match) => match.transport).join(", ")}`))
      }
      return matches[0]!.send()
    })
  )

// Router sends routed envelopes through the transport selected by its host.
export class Router extends Context.Service<
  Router,
  { readonly send: (envelope: RoutedEnvelope) => Effect.Effect<void> }
>()("tardigrade/Router") {}
