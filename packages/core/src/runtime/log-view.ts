// ReadonlyLog is the read surface of an append-only sequence; readonly arrays satisfy it.
export type ReadonlyLog<T> = Pick<ReadonlyArray<T>, "length" | "at" | "find" | "findLast" | "some" | "every" | "filter" | "map" | "flatMap" | "slice" | typeof Symbol.iterator>

// LogView is the first length items of a backing array that only grows. Items below a view's length are never written again, so a view never changes; append writes in place only from the view at the tip and copies otherwise (Go slices, three-index form).
export class LogView<T> implements ReadonlyLog<T> {
  static readonly empty: LogView<never> = new LogView([], 0)

  private constructor(private readonly items: T[], readonly length: number) {
    Object.freeze(this)
  }

  append(batch: readonly T[]): LogView<T> {
    if (batch.length === 0) return this
    const items = this.items.length === this.length ? this.items : this.items.slice(0, this.length)
    for (const item of batch) items.push(item)
    return new LogView(items, items.length)
  }

  at(index: number): T | undefined {
    const position = index < 0 ? this.length + index : index
    return position >= 0 && position < this.length ? this.items[position] : undefined
  }

  *[Symbol.iterator](): ArrayIterator<T> {
    for (let index = 0; index < this.length; index++) yield this.items[index]!
  }

  find<S extends T>(predicate: (value: T, index: number, array: readonly T[]) => value is S): S | undefined
  find(predicate: (value: T, index: number, array: readonly T[]) => unknown): T | undefined
  find(predicate: (value: T, index: number, array: readonly T[]) => unknown): T | undefined {
    for (let index = 0; index < this.length; index++) if (predicate(this.items[index]!, index, this.items)) return this.items[index]
    return undefined
  }

  findLast<S extends T>(predicate: (value: T, index: number, array: readonly T[]) => value is S): S | undefined
  findLast(predicate: (value: T, index: number, array: readonly T[]) => unknown): T | undefined
  findLast(predicate: (value: T, index: number, array: readonly T[]) => unknown): T | undefined {
    for (let index = this.length - 1; index >= 0; index--) if (predicate(this.items[index]!, index, this.items)) return this.items[index]
    return undefined
  }

  some(predicate: (value: T, index: number, array: readonly T[]) => unknown): boolean {
    for (let index = 0; index < this.length; index++) if (predicate(this.items[index]!, index, this.items)) return true
    return false
  }

  every<S extends T>(predicate: (value: T, index: number, array: readonly T[]) => value is S): this is readonly S[]
  every(predicate: (value: T, index: number, array: readonly T[]) => unknown): boolean
  every(predicate: (value: T, index: number, array: readonly T[]) => unknown): boolean {
    for (let index = 0; index < this.length; index++) if (!predicate(this.items[index]!, index, this.items)) return false
    return true
  }

  filter<S extends T>(predicate: (value: T, index: number, array: readonly T[]) => value is S): S[]
  filter(predicate: (value: T, index: number, array: readonly T[]) => unknown): T[]
  filter(predicate: (value: T, index: number, array: readonly T[]) => unknown): T[] {
    const out: T[] = []
    for (let index = 0; index < this.length; index++) if (predicate(this.items[index]!, index, this.items)) out.push(this.items[index]!)
    return out
  }

  map<U>(callback: (value: T, index: number, array: readonly T[]) => U): U[] {
    const out: U[] = []
    for (let index = 0; index < this.length; index++) out.push(callback(this.items[index]!, index, this.items))
    return out
  }

  flatMap<U, This = undefined>(callback: (this: This, value: T, index: number, array: T[]) => U | ReadonlyArray<U>): U[] {
    const out: U[] = []
    for (let index = 0; index < this.length; index++) {
      const value = callback.call(undefined as This, this.items[index]!, index, this.items)
      if (Array.isArray(value)) out.push(...value)
      else out.push(value as U)
    }
    return out
  }

  slice(start?: number, end?: number): T[] {
    const from = start === undefined ? 0 : start < 0 ? Math.max(0, this.length + start) : Math.min(start, this.length)
    const to = end === undefined ? this.length : end < 0 ? Math.max(0, this.length + end) : Math.min(end, this.length)
    return this.items.slice(from, Math.max(from, to))
  }
}
