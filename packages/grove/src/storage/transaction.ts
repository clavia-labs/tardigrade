export type Parameter = string | number | null | Uint8Array
export interface Driver {
  readonly identity: object
  readonly execute: (sql: string, parameters: readonly Parameter[]) => readonly Readonly<Record<string, unknown>>[]
  readonly transaction: <Value>(work: () => Value) => Value
}
declare const transaction: unique symbol
export interface Transaction { readonly [transaction]: true; readonly execute: Driver["execute"] }
export interface Context {
  readonly identity: object
  readonly committed: (() => void)[]
  readonly rollback: Set<() => void>
  failed?: { readonly cause: unknown }
}
const connections = new WeakMap<object, { active?: Context }>(), tokens = new WeakMap<object, Context>()
const asynchronous = (value: unknown) => value !== null && (typeof value === "object" || typeof value === "function") && "then" in value

// transactions shares commit and rollback acknowledgements across storage backends on a connection (test/transactions.test.ts).
export function transactions(driver: Driver) {
  let connection = connections.get(driver.identity)
  if (!connection) { connection = {}; connections.set(driver.identity, connection) }
  const shared = connection
  const guard = (tx: Transaction) => {
    const context = tokens.get(tx)
    if (!context || context !== shared.active || context.identity !== driver.identity) throw new Error("Transaction expired or belongs to another connection")
    if (context.failed) throw context.failed.cause
    return context
  }
  const invoke = <Value>(context: Context, work: (tx: Transaction) => Value): Value => {
    const tx = Object.freeze({ execute: (sql: string, parameters: readonly Parameter[]): ReturnType<Driver["execute"]> => {
      guard(tx as Transaction)
      try { const rows = driver.execute(sql, parameters); if (!Array.isArray(rows)) throw new Error("SQLite statements must complete synchronously"); return rows } catch (cause) { context.failed = { cause }; throw cause }
    } }) as unknown as Transaction
    tokens.set(tx, context)
    try {
      const result = work(tx)
      if (asynchronous(result)) throw new Error("Transactions must be synchronous")
      if (context.failed) throw context.failed.cause
      return result
    } catch (cause) { context.failed = { cause }; throw cause }
    finally { tokens.delete(tx) }
  }
  return {
    active: () => shared.active,
    guard,
    transaction: <Value>(work: (tx: Transaction) => Value): Value => {
      if (shared.active) return invoke(shared.active, work)
      const context: Context = { identity: driver.identity, committed: [], rollback: new Set() }
      let result: Value
      try {
        result = driver.transaction(() => { shared.active = context; try { return invoke(context, work) } finally { delete shared.active } })
        if (asynchronous(result)) throw new Error("SQLite transactions must be synchronous")
      } catch (cause) { context.committed.length = 0; for (const undo of context.rollback) undo(); throw cause }
      try { for (const done of context.committed) done() }
      finally { context.committed.length = 0; context.rollback.clear() }
      return result
    },
  }
}
