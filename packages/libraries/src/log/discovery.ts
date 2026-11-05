import { recordEvent, type EventLog } from "@clavia/tardigrade-core"
import { jsonSchemaOf } from "@clavia/tardigrade-core/json-schema"
import { JsonPointer, Schema } from "effect"
import type { LogPolicy } from "./index"

export const LOG_TABLE = {
  name: "events",
  columns: { position: "INTEGER: zero-based journal position", recorded_at: "INTEGER: journal timestamp in milliseconds, nullable", type: "TEXT: domain event discriminator, nullable", event: "TEXT: domain event as JSON", record: "TEXT: observed journal record as JSON, including envelope and metadata" },
}

interface EventType {
  readonly type: string | null
  readonly schemas: Schema.Json[]
  count: number
  readonly fields: Record<string, string[]>
  readonly samples: Array<{ position: number; text: string; truncated: boolean }>
}
const object = (value: Schema.Json | undefined): Schema.JsonObject | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Schema.JsonObject : undefined

// declaredEventSchemas retains local references when splitting event unions into type descriptions.
function declaredEventSchemas(schema: Schema.Top): Array<{ type: string | null; schema: Schema.Json }> {
  const document = jsonSchemaOf(schema)
  const root = object(document)
  const result: Array<{ type: string | null; schema: Schema.Json }> = []
  const visit = (value: Schema.Json, seen: ReadonlySet<string>) => {
    let member = object(value)
    if (typeof member?.$ref === "string" && member.$ref.startsWith("#")) {
      if (seen.has(member.$ref)) return
      let resolved: Schema.Json | undefined = document
      for (const key of JsonPointer.parseUriFragment(member.$ref) ?? []) resolved = object(resolved)?.[key]
      if (resolved === undefined) throw new Error(`Missing event schema reference: ${member.$ref}`)
      visit(resolved, new Set([...seen, member.$ref]))
      return
    }
    const branches = member?.anyOf ?? member?.oneOf
    if (Array.isArray(branches)) { for (const branch of branches) visit(branch, seen); return }
    const discriminator = object(object(member?.properties)?.type)
    const names = typeof discriminator?.const === "string" ? [discriminator.const] : Array.isArray(discriminator?.enum) ? discriminator.enum.filter((value): value is string => typeof value === "string") : []
    const exported = member ? { ...member, ...(root?.definitions ? { definitions: root.definitions } : {}) } : value
    for (const type of names.length ? names : [null]) result.push({ type, schema: exported })
  }
  visit(document, new Set())
  return result
}

// describeLog separates current declarations from observed shapes within an explicit history window.
export function describeLog(log: typeof EventLog.Service, input: { readonly type?: string | null; readonly cursor?: number | null; readonly limit?: number | null }, policy: LogPolicy) {
  const requestedType = input.type || undefined
  const snapshot = log.snapshot()
  const types = new Map<string | null, EventType>()
  const entry = (type: string | null) => {
    let value = types.get(type)
    if (!value) { value = { type, schemas: [], count: 0, fields: Object.create(null) as Record<string, string[]>, samples: [] }; types.set(type, value) }
    return value
  }
  for (const schema of log.schemas?.() ?? []) for (const value of declaredEventSchemas(schema)) entry(value.type).schemas.push(value.schema)
  const observedThrough = Math.min(snapshot.position, policy.maxScanEvents)
  for (const [position, record] of snapshot.read(0, observedThrough).entries()) {
    const event = recordEvent(record)
    const body = typeof event === "object" && event !== null && !Array.isArray(event) ? event as Record<string, unknown> : undefined
    const value = entry(typeof body?.type === "string" ? body.type : null)
    value.count++
    if (requestedType !== value.type) continue
    for (const [key, field] of Object.entries(body ?? {})) {
      const kind = field === null ? "null" : Array.isArray(field) ? "array" : typeof field
      const kinds = value.fields[key] ??= []
      if (!kinds.includes(kind)) kinds.push(kind)
    }
    if (value.samples.length < policy.maxSamples) {
      const text = JSON.stringify(event)
      value.samples.push({ position, text: text.slice(0, policy.maxRecordChars), truncated: text.length > policy.maxRecordChars })
    }
  }
  const selected = [...types.values()].filter(value => requestedType === undefined || value.type === requestedType).sort((a, b) => (a.type ?? "").localeCompare(b.type ?? ""))
  if (requestedType !== undefined && selected.length === 0) throw new Error("Unknown event type; omit type to list declarations and observed event types")
  const cursor = input.cursor ?? 0
  if (cursor > selected.length) throw new Error("Discovery cursor is outside the event type list")
  const limit = Math.min(input.limit ?? policy.maxResults, policy.maxResults)
  const page = selected.slice(cursor, cursor + limit)
  return {
    table: LOG_TABLE,
    position: snapshot.position, declarationsAvailable: log.schemas !== undefined,
    observedThrough, observedComplete: observedThrough === snapshot.position,
    types: page.map(value => ({
      type: value.type, declared: value.schemas.length > 0, observedCount: value.count,
      schemas: requestedType === undefined ? [] : value.schemas.map(schema => {
        const text = JSON.stringify(schema)
        return { text: text.slice(0, policy.maxRecordChars), truncated: text.length > policy.maxRecordChars }
      }),
      fields: value.fields, samples: value.samples,
    })),
    totalTypes: selected.length, nextCursor: cursor + page.length < selected.length ? cursor + page.length : null,
    limit, policy,
  }
}
