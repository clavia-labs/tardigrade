// ReadonlyLog is the read surface of an append-only sequence; readonly arrays satisfy it. Callbacks receive an item and its index only, so no reader sees past the log's length.
export interface ReadonlyLog<T> {
  readonly length: number
  at(index: number): T | undefined
  find<S extends T>(predicate: (value: T, index: number) => value is S): S | undefined
  find(predicate: (value: T, index: number) => unknown): T | undefined
  findIndex(predicate: (value: T, index: number) => unknown): number
  some(predicate: (value: T, index: number) => unknown): boolean
  filter<S extends T>(predicate: (value: T, index: number) => value is S): S[]
  filter(predicate: (value: T, index: number) => unknown): T[]
  slice(start?: number, end?: number): T[]
  [Symbol.iterator](): Iterator<T>
}

// LogView is the first length items of a backing array that only grows. Items below a view's length are never written again, so a view never changes; append writes in place only from the view at the tip and copies otherwise (Go slices, three-index form; properties/log-view.test.ts).
// The backing array is private to the class, so deep equality and structuredClone see only length; compare or clone view.slice().
export class LogView<T> implements ReadonlyLog<T> {
  static readonly empty: LogView<never> = new LogView([], 0)

  readonly #items: T[]

  private constructor(items: T[], readonly length: number) {
    this.#items = items
  }

  append(batch: readonly T[]): LogView<T> {
    if (batch.length === 0) return this
    // A view of nothing starts a fresh array, so the shared empty view never takes ownership of a log.
    const items = this.length > 0 && this.#items.length === this.length ? this.#items : this.#items.slice(0, this.length)
    for (const item of batch) items.push(item)
    return new LogView(items, items.length)
  }

  // position resolves a relative index against the view's length, clamped to [0, length].
  private position(index: number): number {
    return index < 0 ? Math.max(0, this.length + index) : Math.min(index, this.length)
  }

  at(index: number): T | undefined {
    const position = index < 0 ? this.length + index : index
    return position >= 0 && position < this.length ? this.#items[position] : undefined
  }

  findIndex(predicate: (value: T, index: number) => unknown): number {
    for (let index = 0; index < this.length; index++) if (predicate(this.#items[index]!, index)) return index
    return -1
  }

  find<S extends T>(predicate: (value: T, index: number) => value is S): S | undefined
  find(predicate: (value: T, index: number) => unknown): T | undefined
  find(predicate: (value: T, index: number) => unknown): T | undefined {
    const index = this.findIndex(predicate)
    return index < 0 ? undefined : this.#items[index]
  }

  some(predicate: (value: T, index: number) => unknown): boolean {
    return this.findIndex(predicate) >= 0
  }

  filter<S extends T>(predicate: (value: T, index: number) => value is S): S[]
  filter(predicate: (value: T, index: number) => unknown): T[]
  filter(predicate: (value: T, index: number) => unknown): T[] {
    const out: T[] = []
    for (let index = 0; index < this.length; index++) if (predicate(this.#items[index]!, index)) out.push(this.#items[index]!)
    return out
  }

  slice(start = 0, end = this.length): T[] {
    const from = this.position(start)
    return this.#items.slice(from, Math.max(from, this.position(end)))
  }

  // toJSON serializes the view as its own items, so later appends to the shared backing array stay out of it.
  toJSON(): T[] {
    return this.slice()
  }

  [Symbol.for("nodejs.util.inspect.custom")](): T[] {
    return this.slice()
  }

  *[Symbol.iterator](): Iterator<T> {
    for (let index = 0; index < this.length; index++) yield this.#items[index]!
  }
}
