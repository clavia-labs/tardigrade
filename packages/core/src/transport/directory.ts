import { Effect } from "effect"

// Directory resolves a stable logical identity to its current transport destination.
export interface Directory<Identity, Destination> {
  readonly resolve: (identity: Identity) => Effect.Effect<Destination | undefined>
}

// Placement chooses a transport destination when a directory has no current activation.
export interface Placement<Identity, Destination> {
  readonly place: (identity: Identity) => Effect.Effect<Destination>
}

// directoryWithPlacement resolves an existing activation before applying the stated placement policy.
export const directoryWithPlacement = <Identity, Destination>(
  directory: Directory<Identity, Destination>,
  placement: Placement<Identity, Destination>
): Directory<Identity, Destination> => ({
  resolve: (identity) =>
    directory.resolve(identity).pipe(
      Effect.flatMap((destination) => destination === undefined ? placement.place(identity) : Effect.succeed(destination))
    )
})

// mappedDirectory constructs an effect-free directory from an explicit identity mapping.
export const mappedDirectory = <Identity, Destination>(
  resolve: (identity: Identity) => Destination | undefined
): Directory<Identity, Destination> => ({
  resolve: (identity) => Effect.sync(() => resolve(identity))
})
