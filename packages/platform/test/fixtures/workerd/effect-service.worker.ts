import { DurableObject } from "cloudflare:workers"
import { effectService, effectServiceAlarm, initialEffectServiceState, type EffectServiceState } from "../effect-service"

// EffectServiceDO keeps external job state and alarms outside the actor's Durable Object (operationLifecycle).
export class EffectServiceDO extends DurableObject {
  private readonly service = effectService({
    read: async () => await this.ctx.storage.get<EffectServiceState>("state") ?? initialEffectServiceState(),
    transaction: work => this.ctx.storage.transaction(async tx => {
      const state = await tx.get<EffectServiceState>("state") ?? initialEffectServiceState()
      const result = work(state)
      await tx.put("state", state)
      const at = effectServiceAlarm(state)
      if (at === null) await tx.deleteAlarm()
      else await tx.setAlarm(at)
      return result
    }),
  })
  abort() { this.ctx.abort("External effect service reset fixture") }
  fetch(request: Request) { return this.service.fetch(request) }
  alarm() { return this.service.alarm() }
}
