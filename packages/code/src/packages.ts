import { Context, Effect } from "effect"
import type { Park } from "./errors"

// Mail is one message a source produces, before it becomes a `MessageReceived` on a mailbox.
// `msgId` is the provider's id: the dedup key end to end. `data` carries the structured record
// (a Linear issue, a calendar event); `text` is its readable rendering, and the criteria match
// against it.
export interface Mail {
  readonly msgId: string
  readonly chat?: string
  readonly sender?: string
  readonly text: string
  readonly data?: unknown
}

// DoorRequest is a request through a connection's door: method, a RELATIVE path (the door
// joins it onto the pinned origin, so an absolute URL cannot name another host), headers, and a
// string body. The answer comes back as a value; a provider error is a status the caller reads.
export interface DoorRequest {
  readonly method: string
  readonly path: string // path plus query, always starting with "/"
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  readonly binary?: boolean // answer body comes back base64 (a file download)
  // The calling method's own readOnlyHint, carried onto the request because the door cannot see
  // the package's annotation table: it sees only what crosses the wire. The shadow wall reads
  // this bit; a call that omits it reads as a write, the same dangerous-default the annotations
  // table itself takes.
  readonly readOnlyHint?: boolean
}
export interface DoorAnswer {
  readonly status: number
  readonly body: string
  readonly contentType?: string
  // Response headers, lowercased, set-cookie excluded. A provider protocol that answers in
  // headers (MCP's session id) reads them here; they carry the provider's words, never a stored
  // credential, so the door's confinement holds.
  readonly headers?: Readonly<Record<string, string>>
}
export type DoorFetch = (request: DoorRequest) => Promise<DoorAnswer>

// Connection declares what a package's door needs. `origin` is the pinned egress target,
// derived from the stored values (a region base, a workspace domain). `headers` builds the auth
// attachment INSIDE the door; it may fetch (an OAuth refresh leg) and the credential it reads
// never leaves the door. `required` names the keys that make the connection usable.
export interface Connection {
  readonly required: ReadonlyArray<string>
  readonly origin: (values: Readonly<Record<string, string>>) => string
  readonly headers: (
    values: Readonly<Record<string, string>>,
    fetchImpl: typeof globalThis.fetch
  ) => Promise<Readonly<Record<string, string>>> | Readonly<Record<string, string>>
  // Providers that authenticate in the request body (Composio's connected_account_id) attach it
  // here, inside the door, so the value stays confined exactly like a header credential.
  readonly body?: (values: Readonly<Record<string, string>>, body: string | undefined) => string | undefined
  // Providers whose stored endpoint carries a path (an MCP server URL) rewrite the request path
  // here, inside the door, so the package never reads the value. The result must start with "/".
  readonly path?: (values: Readonly<Record<string, string>>, path: string) => string
  // Providers with expiring credentials renew them here, inside the door, before `headers` reads
  // them. An answer of undefined means nothing changed; changed values are used for this request
  // and persisted by the door's owner, so the renewed credential's whole life stays confined. A
  // throw fails only this request.
  readonly refresh?: (
    values: Readonly<Record<string, string>>,
    fetchImpl: typeof globalThis.fetch
  ) => Promise<Readonly<Record<string, string>> | undefined>
}

// MethodDoc documents one method for `packages.describe` and the dispatch funnel's contract
// gate (contract.ts). `input` and `output` are JSON Schemas of the args object and the returned
// value. A declared `input` is enforced at the funnel; an absent one leaves the method
// unchecked.
export interface MethodDoc {
  readonly description: string
  readonly input?: unknown // JSON schema of the args object
  readonly output?: unknown // JSON schema of the returned value
}

// MethodAnnotations follows the MCP tool-annotation vocabulary and its defaults: a method that
// declares nothing reads as the most dangerous thing it could be (not read-only, destructive,
// not idempotent, open world). The hints are behavioral advice, never security: the shadow-run
// router and the docs read them, and a wrong hint misleads both, so a hint states only what the
// method's own contract guarantees.
export interface MethodAnnotations {
  readonly readOnlyHint?: boolean // observes only; never mutates its environment (default false)
  readonly destructiveHint?: boolean // a non-read-only call may destroy or irreversibly change data (default true)
  readonly idempotentHint?: boolean // repeating the call with the same args adds no further effect (default false)
  readonly openWorldHint?: boolean // touches the world beyond the runtime (default true)
}

export const ANNOTATION_DEFAULTS: Required<MethodAnnotations> = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true
}

// annotationsOf resolves one method's annotations over the dangerous defaults.
export const annotationsOf = (pkg: Package, method: string): Required<MethodAnnotations> => ({
  ...ANNOTATION_DEFAULTS,
  ...pkg.annotations?.[method]
})

// Package is the unit of the real world: a named object with methods; code calls them as
// `zohorecruit.insert_record(args)`. The platform binds the methods to providers; tests bind
// fakes. An MCP server becomes a package through one adapter, never a second concept.
//
// `ctx.callId` is the call's recorded pair key. A method that sends a message across actors
// uses it as the message id, so a replayed call carries the same id and the receiver absorbs
// the duplicate.
// A package declares both directions: `methods` act on the world, `source` is how the world's
// events arrive. A provider with native webhooks declares `webhook` (verify the POST, parse it
// into mail). A provider without push declares `poll` (fetch deltas from a cursor on a
// cadence); the poll reactor is the bridge, and no separate deployable exists. A stateful
// bridge (a held socket) stays outside the package and POSTs the webhook like any provider.
export interface Package {
  readonly name: string
  readonly description: string
  // Method docs, two levels: describe({name}) lists names and one-liners; describe({name,
  // method}) adds the args. Undocumented methods still list, blank.
  readonly docs?: Readonly<Record<string, MethodDoc>>
  // Present when the package speaks to a credentialed provider: its calls go through the
  // connection's door, and the package itself never holds a value.
  readonly connection?: Connection
  // MCP-style behavior hints per method; a missing entry reads as ANNOTATION_DEFAULTS.
  readonly annotations?: Readonly<Record<string, MethodAnnotations>>
  // A method's error channel carries `Park` only: the awaiting fires (`tasks.fire`,
  // `tasks.result`) fail it when a reply has not landed yet, and every other method's `never`
  // error is a subtype of it, so nothing else changes shape.
  readonly methods: Readonly<
    Record<string, (args: unknown, ctx: { readonly callId: string }) => Effect.Effect<unknown, Park>>
  >
  readonly source?: {
    readonly webhook?: {
      readonly verify: (request: { readonly headers: Readonly<Record<string, string>>; readonly body: string }, secret: string) => boolean
      readonly parse: (body: string) => ReadonlyArray<Mail>
    }
    readonly poll?: {
      readonly everyMs: number
      readonly fetch: (cursor: string | null) => Effect.Effect<{ readonly mail: ReadonlyArray<Mail>; readonly cursor: string | null }>
    }
  }
}

// Packages is the registry seam. Which packages exist here is capability scoping: a task that
// must never send messages is bound to a registry that holds no sending package, and the code
// cannot name what the registry does not hold.
export class Packages extends Context.Tag("code/Packages")<
  Packages,
  {
    readonly resolve: (name: string) => Package | undefined
    readonly list: () => Effect.Effect<ReadonlyArray<{ readonly name: string; readonly description: string }>>
  }
>() {}
