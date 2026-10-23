import type { Recorded } from "../journal"

export interface JournalFamily {
  readonly name: string
  readonly indexVersion: string
  readonly key: (record: Recorded<unknown>, position: number) => string | undefined
}

export interface FamilyRecord<Record> {
  readonly position: number
  readonly record: Record
}

export type ReadJournalFamily<Event> = (family: JournalFamily, key: string, from: number, to: number, order?: "asc" | "desc") => Iterable<FamilyRecord<Recorded<Event>>>
export type ReadJournalFamilyKeys = (family: JournalFamily, after: string | undefined, limit: number, position: number) => readonly string[]

export interface FamilyKeyPage {
  readonly keys: readonly string[]
  readonly next?: string
}

// compareFamilyKeys orders Unicode scalar values consistently with SQLite's UTF-8 binary collation.
export function compareFamilyKeys(left: string, right: string): number {
  const a = left[Symbol.iterator]()
  const b = right[Symbol.iterator]()
  while (true) {
    const x = a.next()
    const y = b.next()
    if (x.done || y.done) return x.done ? y.done ? 0 : -1 : 1
    const difference = x.value.codePointAt(0)! - y.value.codePointAt(0)!
    if (difference) return difference
  }
}

// collectFamilyKeys retains the requested ordered key prefix while merging journal and prepared records.
export function collectFamilyKeys(input: Iterable<string | undefined>, after: string | undefined, limit: number): readonly string[] {
  const keys: string[] = []
  for (const key of input) {
    if (key === undefined || (after !== undefined && compareFamilyKeys(key, after) <= 0)) continue
    let from = 0
    let to = keys.length
    while (from < to) {
      const middle = Math.floor((from + to) / 2)
      if (compareFamilyKeys(keys[middle]!, key) < 0) from = middle + 1
      else to = middle
    }
    if (keys[from] === key || from >= limit) continue
    keys.splice(from, 0, key)
    if (keys.length > limit) keys.pop()
  }
  return keys
}
