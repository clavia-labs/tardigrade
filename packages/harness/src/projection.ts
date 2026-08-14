import type { Event } from "@flamecast/core"

export type Projection<Value> = (log: ReadonlyArray<Event>) => Value
