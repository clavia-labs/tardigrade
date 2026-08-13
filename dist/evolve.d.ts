import { j as Envelope } from "./index-HxZ3VQTk.js";
import { Ut as Usage, et as Agent, nt as AgentServices } from "./index-CyN4yol0.js";
import { Effect } from "effect";
//#region packages/evolve/src/candidate.d.ts
interface Candidate<Value> {
  readonly id: string;
  readonly value: Value;
  readonly parent?: string;
  readonly source?: string;
}
interface CandidateOptions {
  readonly parent?: string;
  readonly source?: string;
}
declare const candidate: <Value>(id: string, value: Value, options?: CandidateOptions) => Candidate<Value>;
//#endregion
//#region packages/evolve/src/observe.d.ts
interface ProgramObservation {
  readonly request: ReturnType<Agent["request"]>;
  readonly machines: ReadonlyArray<{
    readonly id: string;
    readonly state: string;
    readonly context: unknown;
  }>;
  readonly dependencies: Readonly<Record<string, unknown>>;
}
declare const observationOf: <R>(agent: Agent<R>, log: ReadonlyArray<Envelope>) => ProgramObservation;
declare const modelCallPrefixes: (log: ReadonlyArray<Envelope>) => ReadonlyArray<ReadonlyArray<Envelope>>;
declare const observationallyEquivalent: <Left, Right>(left: Agent<Left>, right: Agent<Right>, logs: ReadonlyArray<ReadonlyArray<Envelope>>) => boolean;
//#endregion
//#region packages/evolve/src/rollout.d.ts
interface RolloutOptions<Baseline, Candidate> {
  readonly baseline: Agent<Baseline>;
  readonly candidate: Agent<Candidate>;
  readonly log: ReadonlyArray<Envelope>;
}
interface RolloutResult {
  readonly replayed: number;
  readonly called: number;
  readonly usage: Usage;
  readonly log: ReadonlyArray<Envelope>;
}
interface Divergence {
  readonly replayed: number;
  readonly upTo: number;
}
declare const divergence: <Recorded, Candidate>(recorded: Agent<Recorded>, candidate: Agent<Candidate>, log: ReadonlyArray<Envelope>) => Divergence;
declare const rollout: <Baseline, Candidate>(options: RolloutOptions<Baseline, Candidate>) => Effect.Effect<RolloutResult, never, Baseline | Candidate | AgentServices>;
//#endregion
//#region packages/evolve/src/pareto.d.ts
type Scores = Readonly<Record<string, number>>;
interface Identified {
  readonly id: string;
}
interface ParetoArchive<Value extends Identified> {
  readonly add: (value: Value, scores: Scores) => ParetoArchive<Value>;
  readonly front: ReadonlyArray<Value>;
  readonly sample: (rng: () => number) => Value | undefined;
}
declare const paretoArchive: <Value extends Identified>() => ParetoArchive<Value>;
//#endregion
//#region packages/evolve/src/score.d.ts
interface Verdict {
  readonly score: number;
  readonly reason: string;
}
declare const verdictsOf: (log: ReadonlyArray<Envelope>) => ReadonlyArray<Verdict>;
declare const scoreOf: (log: ReadonlyArray<Envelope>) => number;
declare const spendOf: (log: ReadonlyArray<Envelope>) => Usage;
//#endregion
export { type Candidate, type CandidateOptions, type Divergence, type Identified, type ParetoArchive, type ProgramObservation, type RolloutOptions, type RolloutResult, type Scores, type Verdict, candidate, divergence, modelCallPrefixes, observationOf, observationallyEquivalent, paretoArchive, rollout, scoreOf, spendOf, verdictsOf };