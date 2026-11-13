import { effectAtom, eventValue, type ActorOutput, type ActService } from "@clavia/tardigrade-core"
import { durableAtom } from "@clavia/tardigrade-core/experimental"
import type { LibraryContextContribution } from "@clavia/tardigrade-libraries"
import { type Event, type ContextResolved, type ResolvedContext } from "../contracts/events"
import { ResolveContext, requests, failureMessage } from "../contracts/acts"
import { agentLog } from "../experimental/trajectory-log"
import { contextText, mergeContextContributions, type ContextConfiguration } from "../contracts/context"
import { inferenceState } from "./durable/inference"

const contextPages = durableAtom.log(agentLog.view(["ContextResolved"]))

export type ContextPreparation = ActorOutput<
  { readonly position: "ready"; readonly system: string; readonly contributions: readonly LibraryContextContribution[] }
    | { readonly position: "pending" } | { readonly position: "failed"; readonly reason: string },
  Event, ActService<"agent.context.resolve">
>

// prepareContext projects the current model call's resolution from journal pages.
export function prepareContext(configuration: ContextConfiguration) {
  const request = requests(ResolveContext.request, { latestOnly: true })
  const ready = (resolved?: typeof ResolvedContext.Type): ContextPreparation => {
    const contributions = mergeContextContributions(configuration.contributions, resolved?.contributions ?? [])
    const system = [resolved?.system ?? configuration.system ?? "", contextText(contributions, "system")]
      .filter(text => text.trim()).join("\n\n")
    return { view: { position: "ready", system, contributions }, events: {}, acts: {} }
  }
  const needsSnapshot = configuration.dynamic || contextText(configuration.contributions, "user").length > 0
  return effectAtom((get): ContextPreparation => {
    if (!needsSnapshot) return ready()
    const state = get(inferenceState)
    const { turnId, callId } = state
    let page = get(contextPages.range({ from: state.origin ?? 0, limit: 1, order: "desc" }))
    if (!turnId || !state.needsReply || state.running || state.waiting) return ready()
    while (true) {
      const event = page.rows[0]?.value
      if (event?.turnId === turnId && event.callId === callId) return event.error === null ? ready(event) : {
        view: { position: "failed", reason: event.error }, events: {}, acts: {},
      }
      if (!page.next) break
      page = get(contextPages.range({ after: page.next, limit: 1 }))
    }
    if (!configuration.dynamic) return {
      view: { position: "pending" }, acts: {},
      events: { context: eventValue({ type: "ContextResolved", turnId, callId, contributions: [], error: null } satisfies ContextResolved) },
    }
    return { view: { position: "pending" }, events: {}, acts: {
      context: request(callId, {
        ...(state.origin === null ? {} : { origin: state.origin }), input: { turnId, callId },
        // TODO: Reference EffectSettled through a typed act-result lookup instead of copying its payload.
        onSettled: result => [{ type: "ContextResolved", turnId, callId,
          ...(result.status === "fulfilled" ? result.value : { contributions: [] }),
          error: result.status === "fulfilled" ? null : failureMessage(result.reason),
        } satisfies ContextResolved],
      }),
    } }
  })
}
