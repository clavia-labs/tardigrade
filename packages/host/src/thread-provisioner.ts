import { Clock, Effect } from "effect"
import { threadCreationFor, type ThreadProvisioner } from "@clavia/tardigrade-core/actor/supervisor"
import type { ThreadCoordinate } from "@clavia/tardigrade-core/actor/coordinate"
import { threadCreatedOf, type ChildPlacement } from "@clavia/tardigrade-core/interaction/relations"
import type { Event } from "@clavia/tardigrade-core/event"
import type { AppendOptions, AppendResult } from "@clavia/tardigrade-core/log"
import { FORK_EXPECTED_HEAD, forkBatchFor, forkOutcomeOf } from "./fork"

// threadProvisioner creates initial logs through conditional storage appends and reuses persisted creation on retry (thread-provisioner.test.ts).
export const threadProvisioner = (options: {
  readonly read: (target: ThreadCoordinate) => Effect.Effect<ReadonlyArray<Event>>
  readonly append: (target: ThreadCoordinate, events: ReadonlyArray<Event>, options: AppendOptions) => Effect.Effect<AppendResult>
  readonly register: typeof ThreadProvisioner.Service.register
  readonly placement?: ChildPlacement
}): typeof ThreadProvisioner.Service => ({
  create: (input) => Effect.gen(function* () {
    if (input.request.kind === "root" && input.request.fork !== undefined) {
      const fork = input.request.fork
      const batch = forkBatchFor(yield* options.read(fork.source), {
        source: fork.source, seq: fork.seq, dest: input.target.thread
      }, yield* Clock.currentTimeMillis)
      const result = yield* options.append(input.target, batch, { expectedHead: FORK_EXPECTED_HEAD })
      if (result.appended === 0) forkOutcomeOf(yield* options.read(input.target), batch, input.target.thread)
    } else {
      const existing = threadCreatedOf(yield* options.read(input.target))
      if (existing !== undefined) return existing
      const parent = input.request.kind === "child" ? threadCreatedOf(yield* options.read(input.request.parent)) : undefined
      const created = threadCreationFor(input, parent, options.placement, yield* Clock.currentTimeMillis)
      yield* options.append(input.target, [created], { expectedHead: 0 })
    }
    const created = threadCreatedOf(yield* options.read(input.target))
    if (created === undefined) throw new Error("thread creation was not recorded")
    return created
  }),
  register: options.register
})
