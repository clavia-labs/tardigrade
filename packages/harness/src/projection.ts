import type { Envelope } from "@flamecast/core"

export type Projection<Value> = (log: ReadonlyArray<Envelope>) => Value
