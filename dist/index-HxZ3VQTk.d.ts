import { Context, Effect } from "effect";
//#region packages/core/src/envelope.d.ts
type Envelope = {
  readonly type: string;
} & {
  readonly [key: string]: unknown;
};
//#endregion
//#region packages/core/src/event-log.d.ts
interface EventLogStore {
  readonly append: (events: ReadonlyArray<Envelope>) => Effect.Effect<void>;
  readonly read: Effect.Effect<ReadonlyArray<Envelope>>;
  readonly readFrom: (seq: number) => Effect.Effect<ReadonlyArray<Envelope>>;
  readonly head: Effect.Effect<number>;
}
declare const EventLog_base: Context.TagClass<EventLog, "flamecast/EventLog", EventLogStore>;
declare class EventLog extends EventLog_base {}
type DedupKey = (event: Envelope) => string | undefined;
declare const dedupKey: DedupKey;
//#endregion
//#region packages/core/src/machine.d.ts
type Transition<C = never> = string | {
  readonly target: string;
  readonly when?: (log: ReadonlyArray<Envelope>) => boolean;
  readonly assign?: (context: C, event: Envelope) => C;
};
interface StateDef<R, C = never> {
  readonly decide?: (log: ReadonlyArray<Envelope>, now: number, context: C) => ReadonlyArray<Envelope>;
  readonly act?: (log: ReadonlyArray<Envelope>, context: C) => Effect.Effect<ReadonlyArray<Envelope>, never, R>;
  readonly on?: Readonly<Record<string, Transition<C>>>;
}
interface Machine<R = never, C = never> {
  readonly id: string;
  readonly initial: string;
  readonly states: Readonly<Record<string, StateDef<R, C>>>;
  readonly context?: C;
  readonly view?: (log: ReadonlyArray<Envelope>) => ReadonlyArray<Envelope>;
}
interface Fold<C> {
  readonly name: string;
  readonly context: C;
}
declare const erase: <R, C>(m: Machine<R, C>) => Machine<R, never>;
declare const machine: <R = never, C = never>(definition: Machine<R, C>) => Machine<R, C>;
declare const foldOf: <R, C>(m: Machine<R, C>, log: ReadonlyArray<Envelope>) => Fold<C>;
declare const stateOf: <R, C>(m: Machine<R, C>, log: ReadonlyArray<Envelope>) => string;
declare const settle: <R, C>(m: Machine<R, C>) => Effect.Effect<void, never, EventLog | R>;
declare const resting: <R>(machines: ReadonlyArray<Machine<R, never>>, log: ReadonlyArray<Envelope>) => boolean;
declare const settleAll: <R>(machines: ReadonlyArray<Machine<R, never>>) => Effect.Effect<void, never, EventLog | R>;
//#endregion
//#region packages/core/src/actor.d.ts
declare const Self_base: Context.TagClass<Self, "flamecast/Self", string>;
declare class Self extends Self_base {}
interface Actor<R = never> {
  readonly machines: ReadonlyArray<Machine<R, never>>;
}
declare const actor: <R = never>(machines: ReadonlyArray<Machine<R, never>>) => Actor<R>;
declare const send: <R>(a: Actor<R>, event: Envelope) => Effect.Effect<void, never, EventLog | R>;
//#endregion
//#region packages/core/src/router.d.ts
declare const Router_base: Context.TagClass<Router, "flamecast/Router", {
  readonly deliver: (address: string, event: Envelope) => Effect.Effect<void>;
  readonly call: (address: string, event: Envelope) => Effect.Effect<Envelope>;
}>;
declare class Router extends Router_base {}
//#endregion
//#region packages/core/src/ports.d.ts
declare const Writer_base: Context.TagClass<Writer, "flamecast/Writer", {
  readonly hold: <A, E, R>(session: string, work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}>;
declare class Writer extends Writer_base {}
declare const Wake_base: Context.TagClass<Wake, "flamecast/Wake", {
  readonly armIfSooner: (at: number) => Effect.Effect<void>;
  readonly owed: Effect.Effect<ReadonlyArray<{
    session: string;
    at: number;
  }>>;
}>;
declare class Wake extends Wake_base {}
declare const Placement_base: Context.TagClass<Placement, "flamecast/Placement", {
  readonly home: (address: string) => Effect.Effect<string>;
}>;
declare class Placement extends Placement_base {}
declare const Spill_base: Context.TagClass<Spill, "flamecast/Spill", {
  readonly put: (value: Uint8Array) => Effect.Effect<string>;
  readonly get: (ref: string) => Effect.Effect<Uint8Array>;
}>;
declare class Spill extends Spill_base {}
type SinkRecord = Envelope & {
  readonly session: string;
  readonly turn?: string;
};
declare const Sink_base: Context.TagClass<Sink, "flamecast/Sink", {
  readonly write: (records: ReadonlyArray<SinkRecord>) => Effect.Effect<void>;
}>;
declare class Sink extends Sink_base {}
//#endregion
//#region packages/core/src/conformance.d.ts
interface Check {
  readonly ok: boolean;
  readonly failures: ReadonlyArray<string>;
}
interface ConformanceReport {
  readonly ok: boolean;
  readonly purity: Check;
  readonly idempotence: Check;
  readonly wedge: Check;
  readonly dedup: Check;
}
interface ConformanceOptions {
  readonly machines: ReadonlyArray<Machine<unknown, never>>;
  readonly logs: ReadonlyArray<ReadonlyArray<Envelope>>;
  readonly keyOf: DedupKey;
}
declare const conformance: (options: ConformanceOptions) => Effect.Effect<ConformanceReport, never, never>;
//#endregion
export { dedupKey as A, resting as C, DedupKey as D, stateOf as E, EventLog as O, machine as S, settleAll as T, Machine as _, Placement as a, erase as b, Spill as c, Router as d, Actor as f, Fold as g, send as h, conformance as i, Envelope as j, EventLogStore as k, Wake as l, actor as m, ConformanceOptions as n, Sink as o, Self as p, ConformanceReport as r, SinkRecord as s, Check as t, Writer as u, StateDef as v, settle as w, foldOf as x, Transition as y };