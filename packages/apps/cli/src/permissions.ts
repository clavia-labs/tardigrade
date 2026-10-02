import { Deferred, Effect, Layer } from "effect"
import { type ActorRuntime, RuntimeError } from "@clavia/tardigrade-core"
import { PermissionRequests, deferDecision } from "@clavia/tardigrade-agent/services/decisions"
import { permissionState } from "@clavia/tardigrade-agent/atoms/durable/permissions"
import { AskPermission } from "@clavia/tardigrade-agent/contracts/acts"
import { updatePermission, type Decision, type Event, type PermissionPolicy, type PermissionRequest } from "@clavia/tardigrade-agent/contracts/events"

export const PERMISSION_MODES = ["ask", "auto", "full-access"] as const
export type PermissionMode = typeof PERMISSION_MODES[number]
export const DEFAULT_PERMISSION_MODE: PermissionMode = "ask"
export interface PermissionNotice { readonly seq: number; readonly kind: "permission"; readonly text: string }

function permissionPolicy(mode: PermissionMode): typeof PermissionPolicy.Type {
  return { default: mode === "full-access" ? "allow" : "ask", actions: mode === "auto" ? { "tool.execute": { resources: {}, readOnly: "allow" } } : {} }
}

// createPermissions shares CLI policy and approval requests across opened actors and their children.
export function createPermissions(options: { readonly mode?: PermissionMode; readonly interactive: boolean }) {
  let mode = options.mode ?? DEFAULT_PERMISSION_MODE
  let sequence = 0
  const runtimes = new Set<ActorRuntime<Event>>()
  const listeners = new Set<(notice: PermissionNotice) => void>()
  const pending = new Map<string, { readonly label: string; readonly request: typeof PermissionRequest.Type; readonly answer: Deferred.Deferred<typeof Decision.Type> }>()
  const notice = (id: string, request: { readonly label: string; readonly request: typeof PermissionRequest.Type }): PermissionNotice => ({
    seq: -1, kind: "permission", text: `${id}  ${request.label}\n${request.request.action} · ${request.request.resource}\n${JSON.stringify(request.request.input, null, 2)}\n/allow ${id}  /deny ${id}`,
  })
  return {
    mode: () => mode,
    subscribe(listener: (notice: PermissionNotice) => void) {
      listeners.add(listener)
      for (const [id, request] of pending) listener(notice(id, request))
      return () => { listeners.delete(listener) }
    },
    list: () => [...pending].map(([id, request]) => notice(id, request)),
    decide(id: string, allowed: boolean) {
      const request = pending.get(id)
      if (!request) throw new RuntimeError(`Unknown approval: ${id}. Use /approvals to list pending requests.`)
      pending.delete(id)
      Deferred.doneUnsafe(request.answer, Effect.succeed({ allowed, reason: `User ${allowed ? "approved" : "denied"} ${request.request.resource}` }))
    },
    change(next: PermissionMode) {
      return Effect.gen(function* () {
        mode = next
        for (const runtime of runtimes) yield* runtime.send([updatePermission(permissionPolicy(next))])
      })
    },
    layer(runtime: ActorRuntime<Event>, label: string) {
      return Layer.effect(PermissionRequests, Effect.gen(function* () {
        yield* Effect.acquireRelease(Effect.sync(() => { runtimes.add(runtime) }), () => Effect.sync(() => { runtimes.delete(runtime) }))
        yield* runtime.onReady(Effect.gen(function* () {
          const policy = permissionPolicy(mode)
          yield* runtime.record(runtime.get(permissionState).policy !== null
            ? updatePermission(policy) : { type: "PermissionConfigured", policy })
          for (const request of runtime.get(AskPermission.pending)) {
            if (request.handle.executor === "local") {
              yield* runtime.record({ type: "PromiseSettled", ref: request.ref, result: { status: "fulfilled", value: { allowed: false, reason: "Approval interrupted by CLI shutdown. Request permission again." } } })
            }
          }
        }))
        return {
          request: (permission: typeof PermissionRequest.Type) => {
            if (!options.interactive) return Effect.succeed({ type: "decision" as const, decision: { allowed: false, reason: `Approval required for ${permission.resource}; noninteractive chat cannot ask. Use interactive chat or explicitly select --permissions auto or full-access.` } })
            return deferDecision(Effect.gen(function* () {
              const id = String(++sequence)
              const answer = Deferred.makeUnsafe<typeof Decision.Type>()
              const request = { label, request: permission, answer }
              return yield* Effect.acquireUseRelease(
                Effect.sync(() => {
                  pending.set(id, request)
                  for (const listener of listeners) listener(notice(id, request))
                }),
                () => Deferred.await(answer),
                () => Effect.sync(() => { pending.delete(id) }),
              )
            }))
          },
        }
      }))
    },
  }
}
export type Permissions = ReturnType<typeof createPermissions>
