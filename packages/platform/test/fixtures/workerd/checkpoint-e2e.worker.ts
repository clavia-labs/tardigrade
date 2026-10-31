import { Context, Layer } from "effect"
import { createActorWorker, type CloudflareObjectBindings } from "../../../src/cloudflare"
import { checkpointActor } from "../atoms/checkpoint-actor"
import { atomPopulationKinds, type AtomPopulationKind } from "../atoms/population"

const worker = (kind: AtomPopulationKind) => createActorWorker({ actor: checkpointActor(kind),
  checkpointPolicy: { mode: "threshold", options: { everyEvents: 1 } }, actorContext: Context.pick(), services: () => Layer.empty,
})
const bindingsFor = (kind: AtomPopulationKind, env: CheckpointBindings) => ({
  regular: { ACTORS: env.CHECKPOINT_REGULAR_ACTORS, THREADS: env.CHECKPOINT_REGULAR_THREADS },
  family: { ACTORS: env.CHECKPOINT_FAMILY_ACTORS, THREADS: env.CHECKPOINT_FAMILY_THREADS },
  mixed: { ACTORS: env.CHECKPOINT_MIXED_ACTORS, THREADS: env.CHECKPOINT_MIXED_THREADS },
})[kind]
const objects = (kind: AtomPopulationKind) => {
  const target = worker(kind)
  return { ...target,
    ActorObject: class extends target.ActorObject {
      constructor(ctx: ConstructorParameters<typeof target.ActorObject>[0], env: ConstructorParameters<typeof target.ActorObject>[1]) {
        super(ctx, { ...env, ...bindingsFor(kind, env as unknown as CheckpointBindings) })
      }
    },
    ThreadObject: class extends target.ThreadObject {
      constructor(ctx: ConstructorParameters<typeof target.ThreadObject>[0], env: ConstructorParameters<typeof target.ThreadObject>[1]) {
        super(ctx, { ...env, ...bindingsFor(kind, env as unknown as CheckpointBindings) })
      }
      abort() { this.ctx.abort("Checkpoint E2E reset") }
    },
  }
}
const workers = { regular: objects("regular"), family: objects("family"), mixed: objects("mixed") }
export class RegularCheckpointActorDO extends workers.regular.ActorObject {}
export class FamilyCheckpointActorDO extends workers.family.ActorObject {}
export class MixedCheckpointActorDO extends workers.mixed.ActorObject {}
export class RegularCheckpointThreadDO extends workers.regular.ThreadObject {}
export class FamilyCheckpointThreadDO extends workers.family.ThreadObject {}
export class MixedCheckpointThreadDO extends workers.mixed.ThreadObject {}

interface CheckpointBindings {
  readonly CHECKPOINT_REGULAR_ACTORS: CloudflareObjectBindings["ACTORS"]
  readonly CHECKPOINT_REGULAR_THREADS: CloudflareObjectBindings["THREADS"]
  readonly CHECKPOINT_FAMILY_ACTORS: CloudflareObjectBindings["ACTORS"]
  readonly CHECKPOINT_FAMILY_THREADS: CloudflareObjectBindings["THREADS"]
  readonly CHECKPOINT_MIXED_ACTORS: CloudflareObjectBindings["ACTORS"]
  readonly CHECKPOINT_MIXED_THREADS: CloudflareObjectBindings["THREADS"]
}

export function checkpointFetch(request: Request, env: CheckpointBindings) {
  const path = new URL(request.url).pathname
  const kind = atomPopulationKinds.find(kind => path.startsWith(`/v1/actors/checkpoint-e2e-${kind}/`))
  if (!kind) return Promise.resolve(new Response("Unknown checkpoint population", { status: 404 }))
  return workers[kind].fetch(request, bindingsFor(kind, env))
}
