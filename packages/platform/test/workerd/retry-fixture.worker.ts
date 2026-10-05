import { Context, Effect } from "effect"
import { RuntimeError, type EffectRef } from "@clavia/tardigrade-core"
import { createActorWorker, type CloudflareObjectBindings } from "../../src/cloudflare"
import { retryActor, retryServices, type RetryServiceOptions } from "../fixtures/retry-actor"

interface RetryBindings {
  readonly RETRY_ACTORS: CloudflareObjectBindings["ACTORS"]
  readonly RETRY_THREADS: CloudflareObjectBindings["THREADS"]
}
const bindings = (env: RetryBindings): Record<string, unknown> & CloudflareObjectBindings => ({ ACTORS: env.RETRY_ACTORS, THREADS: env.RETRY_THREADS })
const fixtures = new Map<string, ReturnType<typeof retryServices>>()
export const configureRetry = (instance: string, options: RetryServiceOptions) => { fixtures.set(instance, retryServices(options)) }
const fixtureOf = (instance: string) => {
  const fixture = fixtures.get(instance)
  if (!fixture) throw new RuntimeError("Retry fixture was not configured")
  return fixture
}
const worker = createActorWorker({ actor: retryActor, actorContext: Context.pick(), watchdog: { policy: { keepAliveIntervalMs: 20, retryIntervalMs: 20 } }, services: (_env, coordinate) => fixtureOf(coordinate.instance).services })
export class RetryActorDO extends worker.ActorObject {
  constructor(ctx: ConstructorParameters<typeof worker.ActorObject>[0], env: RetryBindings) { super(ctx, bindings(env)) }
}
export class RetryThreadDO extends worker.ThreadObject {
  constructor(ctx: ConstructorParameters<typeof worker.ThreadObject>[0], env: RetryBindings) { super(ctx, bindings(env)) }
  async cancelEffect(instance: string, ref: EffectRef) { await Effect.runPromise(fixtureOf(instance).cancel(ref)) }
  stats(instance: string) { const fixture = fixtureOf(instance); return { attempts: fixture.attempts(), startedAt: fixture.startedAt() } }
}
export const retryFetch = (request: Request, env: RetryBindings) => worker.fetch(request, bindings(env))
