import { Context } from "effect"
import { RuntimeError } from "@clavia/tardigrade-core"
import { createActorWorker, type CloudflareObjectBindings } from "../../../src/cloudflare"
import { slowActor, slowServices, type SlowActOptions } from "../slow-act"

export const SLOW_ACT_WATCHDOG_POLICY = { attemptTimeoutMs: 100, keepAliveIntervalMs: 20, retryIntervalMs: 20, maxRetryIntervalMs: 40, maxNoProgressAttempts: 3 } as const

interface SlowBindings {
  readonly SLOW_ACTORS: CloudflareObjectBindings["ACTORS"]
  readonly SLOW_THREADS: CloudflareObjectBindings["THREADS"]
}
const bindings = (env: SlowBindings): Record<string, unknown> & CloudflareObjectBindings => ({ ACTORS: env.SLOW_ACTORS, THREADS: env.SLOW_THREADS })
const fixtures = new Map<string, ReturnType<typeof slowServices>>()
export const configureSlowAct = (instance: string, options: SlowActOptions) => { fixtures.set(instance, slowServices(options)) }
export const forgetSlowAct = (instance: string) => { fixtures.delete(instance) }
const fixtureOf = (instance: string) => {
  const fixture = fixtures.get(instance)
  if (!fixture) throw new RuntimeError("Slow act fixture was not configured")
  return fixture
}
export const logSlowAct = (instance: string) => fixtureOf(instance).log()
const worker = createActorWorker({ actor: slowActor, actorContext: Context.pick(), watchdog: { policy: SLOW_ACT_WATCHDOG_POLICY }, services: (_env, coordinate) => fixtureOf(coordinate.instance).services })
export class SlowActorDO extends worker.ActorObject {
  constructor(ctx: ConstructorParameters<typeof worker.ActorObject>[0], env: SlowBindings) { super(ctx, bindings(env)) }
}
export class SlowThreadDO extends worker.ThreadObject {
  constructor(ctx: ConstructorParameters<typeof worker.ThreadObject>[0], env: SlowBindings) { super(ctx, bindings(env)) }
  log(instance: string) { return fixtureOf(instance).log() }
  crash() { this.ctx.abort("watchdog cold recovery property") }
}
export const slowFetch = (request: Request, env: SlowBindings) => worker.fetch(request, bindings(env))
