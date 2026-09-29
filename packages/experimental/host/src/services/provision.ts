import { Context, Effect } from "effect"
import { Provision, type ThreadAllocation } from "../supervisor"

export class ThreadProvisioner extends Context.Service<ThreadProvisioner, {
  readonly provision: (allocation: ThreadAllocation) => Effect.Effect<void, Error>
}>()("experimental/ThreadProvisioner") {}

export const provisionThreads = Provision.layer(allocation => ThreadProvisioner.use(service => service.provision(allocation)).pipe(Effect.as(null), Effect.mapError(String)))
