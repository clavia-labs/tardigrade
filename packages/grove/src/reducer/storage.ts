export type Parameter = string | number | null | Uint8Array
export type Row = Readonly<Record<string, Parameter>>

// Sqlite provides an exclusively owned synchronous connection; wrappers for the same connection share identity.
export interface Sqlite {
  readonly identity: object
  readonly execute: (sql: string, parameters: readonly Parameter[]) => readonly Row[]
  readonly transaction: <Value>(work: () => Value) => Value
}

export type { Transaction } from "../storage/transaction"
