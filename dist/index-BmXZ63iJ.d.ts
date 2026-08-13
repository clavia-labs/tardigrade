import { D as DedupKey, O as EventLog, _ as Machine, d as Router, j as Envelope, l as Wake, p as Self, u as Writer } from "./index-HxZ3VQTk.js";
import { Context, Effect, Layer } from "effect";
//#region packages/harness/src/infer.d.ts
interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}
interface ToolContext {
  readonly turn: string;
  readonly callId: string;
}
interface Tool<R = never> {
  readonly spec: ToolSpec;
  readonly run: (input: unknown, context?: ToolContext) => Effect.Effect<unknown, never, R>;
}
interface AgentToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}
interface AgentMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly toolCalls?: ReadonlyArray<AgentToolCall>;
  readonly toolCallId?: string;
}
interface ModelRequest {
  readonly system: string;
  readonly messages: ReadonlyArray<AgentMessage>;
  readonly tools: ReadonlyArray<ToolSpec>;
}
interface Usage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly costUsd: number;
}
type Action = {
  readonly kind: "call";
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly text?: string | undefined;
  readonly usage?: Usage | undefined;
} | {
  readonly kind: "complete";
  readonly output: string;
  readonly usage?: Usage | undefined;
} | {
  readonly kind: "fail";
  readonly error: string;
  readonly usage?: Usage | undefined;
};
interface InferenceState {
  readonly provider: string;
  readonly model: string;
  readonly contextWindow: number;
}
interface InferenceProvider {
  readonly id: string;
  readonly state: (log: ReadonlyArray<Envelope>) => InferenceState;
  readonly react: (request: ModelRequest, key: string) => Effect.Effect<Action>;
}
type InferenceSelection = InferenceProvider | ((log: ReadonlyArray<Envelope>) => InferenceProvider);
declare const selectedInference: (selection: InferenceSelection, log: ReadonlyArray<Envelope>) => InferenceProvider;
interface CustomInferenceOptions {
  readonly id?: string;
  readonly model?: string;
  readonly contextWindow?: number;
}
declare const customInference: (react: (request: ModelRequest, key: string) => Promise<Action>, options?: CustomInferenceOptions) => InferenceProvider;
declare const Infer_base: Context.TagClass<Infer, "flamecast/Infer", InferenceProvider>;
declare class Infer extends Infer_base {}
declare const inferWith: (react: (request: ModelRequest, key: string) => Promise<Action>, options?: CustomInferenceOptions) => Layer.Layer<Infer>;
//#endregion
//#region packages/harness/src/signal.d.ts
declare const SignalValue: unique symbol;
interface Signal<Id extends string, Value> {
  readonly id: Id;
  readonly [SignalValue]?: Value;
}
type AnySignal = Signal<string, unknown>;
type ValueOf<S extends AnySignal> = S extends Signal<string, infer Value> ? Value : never;
interface Announcement<S extends AnySignal> {
  readonly signal: S;
  readonly read: (log: ReadonlyArray<Envelope>) => ValueOf<S>;
}
declare const signal: <const Id extends string, Value>(id: Id) => Signal<Id, Value>;
declare const announce: <S extends AnySignal>(signal: S, read: (log: ReadonlyArray<Envelope>) => ValueOf<S>) => Announcement<S>;
interface ModuleContext<Requires extends readonly AnySignal[]> {
  readonly read: <S extends Requires[number]>(signal: S, log: ReadonlyArray<Envelope>) => ValueOf<S>;
}
//#endregion
//#region packages/harness/src/program.d.ts
interface Instruction {
  readonly id: string;
  readonly text: string;
}
type NudgePlacement = "tail" | "system";
interface Nudge {
  readonly id: string;
  readonly when: (log: ReadonlyArray<Envelope>) => boolean;
  readonly text: string;
  readonly placement?: NudgePlacement;
  readonly tools?: ReadonlyArray<ToolSpec> | ((log: ReadonlyArray<Envelope>) => ReadonlyArray<ToolSpec>);
  readonly withdraws?: ReadonlyArray<string>;
}
declare const WITHDRAW_ALL = "*";
interface RenderPlan {
  readonly instructions: ReadonlyArray<Instruction>;
  readonly tools: ReadonlyArray<ToolSpec>;
  readonly nudges: ReadonlyArray<Nudge>;
  readonly messageTruncateAt: number;
  readonly resultTruncateAt: number;
}
interface ModuleManifest {
  readonly id: string;
  readonly version: string;
  readonly fingerprint?: unknown;
}
interface AgentProgram<R = never> {
  readonly id: string;
  readonly parent?: string;
  readonly modules: ReadonlyArray<ModuleManifest>;
  readonly events: ReadonlyArray<string>;
  readonly machines: ReadonlyArray<Machine<R, never>>;
  readonly render: RenderPlan;
  readonly announcements: ReadonlyArray<Announcement<AnySignal>>;
}
declare const programId: (modules: ReadonlyArray<ModuleManifest>) => string;
declare const readSignal: <S extends AnySignal>(program: Pick<AgentProgram<never>, "announcements">, signal: S, log: ReadonlyArray<Envelope>) => ValueOf<S>;
declare const canonicalValue: (value: unknown) => string;
//#endregion
//#region packages/harness/src/boundary.d.ts
type CallResult = {
  readonly kind: "completed";
  readonly output: string;
} | {
  readonly kind: "failed";
  readonly error: string;
} | {
  readonly kind: "parked";
  readonly callId: string;
  readonly reason: string;
  readonly amount: number;
};
declare const boundaryOf: (log: ReadonlyArray<Envelope>, turn: string) => CallResult | undefined;
//#endregion
//#region packages/harness/src/module.d.ts
type AgentServices = EventLog | Writer | Wake | Router | Self;
interface ModulePart<R = never> {
  readonly events?: ReadonlyArray<string>;
  readonly machines?: ReadonlyArray<Machine<R, never>> | ((render: RenderPlan) => ReadonlyArray<Machine<R, never>>);
  readonly instructions?: ReadonlyArray<Instruction>;
  readonly nudges?: ReadonlyArray<Nudge>;
  readonly tools?: ReadonlyArray<ToolSpec>;
  readonly render?: Partial<Pick<RenderPlan, "messageTruncateAt" | "resultTruncateAt">>;
}
interface Module<Id extends string = string, Provides extends readonly Announcement<AnySignal>[] = readonly [], Requires extends readonly AnySignal[] = readonly [], R = never> {
  readonly id: Id;
  readonly version?: string;
  readonly fingerprint?: unknown;
  readonly provides?: Provides;
  readonly requires?: Requires;
  readonly setup: (context: ModuleContext<Requires>) => ModulePart<R>;
}
type AnyModule = Module<string, any, any, any>;
declare const defineModule: <const Id extends string, const Provides extends readonly Announcement<AnySignal>[] = readonly [], const Requires extends readonly AnySignal[] = readonly [], R = never>(module: Module<Id, Provides, Requires, R>) => Module<Id, Provides, Requires, R>;
type ModuleId<One> = One extends Module<infer Id, any, any, any> ? Id : never;
type ProvidedSignal<One> = One extends Module<string, infer Provides, any, any> ? Provides[number]["signal"] : never;
type RequiredSignal<One> = One extends Module<string, any, infer Requires, any> ? Requires[number] : never;
type SignalId<One> = One extends Signal<infer Id, unknown> ? Id : never;
type MissingSignals<Modules extends readonly unknown[]> = Exclude<SignalId<RequiredSignal<Modules[number]>>, SignalId<ProvidedSignal<Modules[number]>>>;
type DuplicateModuleIds<Modules extends readonly unknown[], Seen extends string = never> = Modules extends readonly [infer Head, ...infer Tail] ? ModuleId<Head> extends Seen ? ModuleId<Head> : DuplicateModuleIds<Tail, Seen | ModuleId<Head>> : never;
type ModuleServices<One> = One extends Module<string, any, any, infer R> ? R : never;
type ValidModules<Modules extends readonly unknown[]> = [MissingSignals<Modules>] extends [never] ? [DuplicateModuleIds<Modules>] extends [never] ? unknown : {
  readonly duplicateModuleIds: DuplicateModuleIds<Modules>;
} : {
  readonly missingModuleSignals: MissingSignals<Modules>;
};
interface InboundMessage {
  readonly id: string;
  readonly text: string;
  readonly output?: unknown;
  readonly budget?: number;
  readonly escalatable?: boolean;
  readonly replyTo?: string;
}
type TurnOutcome = CallResult | {
  readonly kind: "open";
};
type TurnResult = TurnOutcome & {
  readonly turn: string;
  readonly usage: Usage;
};
interface BranchOptions {
  readonly at?: number;
  readonly id?: string;
}
interface Agent<R = never> {
  readonly program: AgentProgram<R>;
  readonly turn: (message: InboundMessage) => Effect.Effect<TurnResult, never, R | AgentServices>;
  readonly log: Effect.Effect<ReadonlyArray<Envelope>, never, EventLog>;
  readonly replay: (recorded: ReadonlyArray<Envelope>) => Effect.Effect<TurnResult, never, R | AgentServices>;
  readonly request: (log: ReadonlyArray<Envelope>) => ModelRequest;
  readonly read: <S extends AnySignal>(signal: S, log: ReadonlyArray<Envelope>) => ValueOf<S>;
  readonly branch: (recorded: ReadonlyArray<Envelope>, options?: BranchOptions) => Agent<R>;
  readonly fork: (options?: BranchOptions) => Effect.Effect<Agent<R>, never, EventLog | Self>;
}
interface AgentOptions<Modules extends readonly AnyModule[]> {
  readonly id?: string;
  readonly parent?: string;
  readonly modules: Modules;
}
declare const undeclaredEvents: (program: Pick<AgentProgram<never>, "events">, log: ReadonlyArray<Envelope>) => ReadonlyArray<string>;
declare const createAgent: <const Modules extends readonly AnyModule[]>(options: AgentOptions<Modules> & ValidModules<Modules>) => Agent<ModuleServices<Modules[number]>>;
//#endregion
//#region packages/harness/src/modules/budget.d.ts
declare const budgetOf: (log: ReadonlyArray<Envelope>, fallback?: number) => number;
declare const usedOf: (log: ReadonlyArray<Envelope>) => number;
declare const escalatableOf: (log: ReadonlyArray<Envelope>) => boolean;
type BudgetPhase = "spending" | "exhausted" | "denied";
declare const budgetPhase: (log: ReadonlyArray<Envelope>) => BudgetPhase;
declare const budgetSpent: (log: ReadonlyArray<Envelope>) => boolean;
declare const canRequestBudget: (log: ReadonlyArray<Envelope>) => boolean;
interface BudgetOptions {
  readonly defaultBudget?: number;
  readonly wallText?: string;
  readonly escalateText?: string;
  readonly requestDescription?: string;
}
declare const budget: (options?: BudgetOptions) => Module<"budget", readonly [], readonly [], never>;
//#endregion
//#region packages/harness/src/modules/compaction.d.ts
declare const TRIGGER_RATIO = 0.8;
declare const KEEP_RATIO = 0.2;
declare const COMPRESSION_RATIO = 0.5;
interface MorphOptions {
  readonly apiKey?: string | undefined;
  readonly apiUrl?: string | undefined;
  readonly triggerAt?: number | undefined;
  readonly keepAt?: number | undefined;
  readonly fireTokens?: number | undefined;
  readonly keepTokens?: number | undefined;
  readonly compressionRatio?: number | undefined;
  readonly fetch?: typeof fetch | undefined;
}
declare const naiveSummary: (input: string, ratio: number) => string;
declare const morphCompaction: (options?: MorphOptions) => Module<"compaction", readonly [], readonly [Signal<"inference.state", InferenceState>], never>;
//#endregion
//#region packages/harness/src/modules/contract.d.ts
interface ContractOptions {
  readonly nudge?: string;
  readonly answerDescription?: string;
}
declare const contract: (options?: ContractOptions) => Module<"contract", readonly [], readonly [], never>;
//#endregion
//#region packages/harness/src/modules/inference.d.ts
declare const inferenceState: Signal<"inference.state", InferenceState>;
interface InferenceOptions {
  readonly provider?: InferenceSelection;
  readonly system?: string;
  readonly giveUpAfter?: number;
  readonly repairAtMost?: number;
  readonly messageTruncateAt?: number;
  readonly resultTruncateAt?: number;
}
declare const inference: (options?: InferenceOptions) => Module<"inference", readonly [Announcement<Signal<"inference.state", InferenceState>>], readonly [], never>;
//#endregion
//#region packages/harness/src/pack.d.ts
interface DefaultPackOptions<R = never> {
  readonly inference?: InferenceOptions;
  readonly tools?: ReadonlyArray<Tool<R>>;
  readonly budget?: BudgetOptions;
  readonly contract?: ContractOptions;
  readonly compaction?: MorphOptions;
}
declare const defaultPack: <R = never>(options?: DefaultPackOptions<R>) => readonly [Module<"inference", readonly [Announcement<Signal<"inference.state", InferenceState>>], readonly [], never>, Module<"tools", readonly [], readonly [], R>, Module<"budget", readonly [], readonly [], never>, Module<"contract", readonly [], readonly [], never>, Module<"compaction", readonly [], readonly [Signal<"inference.state", InferenceState>], never>];
//#endregion
//#region packages/harness/src/render.d.ts
declare const toolSurface: (render: RenderPlan, log: ReadonlyArray<Envelope>) => ReadonlyArray<ToolSpec>;
declare const systemPrompt: (render: RenderPlan, log: ReadonlyArray<Envelope>) => string;
declare const renderMessages: (render: RenderPlan, log: ReadonlyArray<Envelope>) => ReadonlyArray<AgentMessage>;
declare const modelRequest: (program: Pick<AgentProgram<never>, "render">, log: ReadonlyArray<Envelope>) => ModelRequest;
//#endregion
//#region packages/harness/src/turns.d.ts
declare const turnHead: (log: ReadonlyArray<Envelope>) => Envelope | undefined;
declare const turnOf: (log: ReadonlyArray<Envelope>) => string;
declare const turnView: (log: ReadonlyArray<Envelope>) => ReadonlyArray<Envelope>;
declare const replyView: (log: ReadonlyArray<Envelope>) => ReadonlyArray<Envelope>;
declare const servedLog: (log: ReadonlyArray<Envelope>) => ReadonlyArray<Envelope>;
declare const usageIn: (log: ReadonlyArray<Envelope>, turn: string) => Usage;
declare const transcript: (log: ReadonlyArray<Envelope>) => string;
//#endregion
//#region packages/harness/src/context.d.ts
declare const estimateTokens: (events: ReadonlyArray<Envelope>) => number;
interface Checkpoint {
  readonly upTo: number;
  readonly summary: string;
}
declare const checkpointOf: (log: ReadonlyArray<Envelope>) => Checkpoint;
declare const suffixOf: (log: ReadonlyArray<Envelope>) => ReadonlyArray<Envelope>;
declare const keepUpTo: (log: ReadonlyArray<Envelope>, keepTokens: number) => number;
//#endregion
//#region packages/harness/src/keys.d.ts
declare const keyOf: DedupKey;
//#endregion
//#region packages/harness/src/schema.d.ts
declare const answerErrors: (schema: unknown, answer: unknown) => ReadonlyArray<string>;
declare const repairText: (errors: ReadonlyArray<string>) => string;
//#endregion
//#region packages/harness/src/exits.d.ts
declare const ANSWER = "answer";
declare const REQUEST_BUDGET = "request-budget";
declare const EXITS: ReadonlySet<string>;
//#endregion
//#region packages/harness/src/providers/cloudflare-gateway.d.ts
interface CloudflareGatewayInferenceOptions {
  readonly accountId?: string;
  readonly apiToken?: string;
  readonly gatewayId?: string;
  readonly model?: string;
  readonly contextWindow?: number;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}
declare const cloudflareGatewayInference: (options?: CloudflareGatewayInferenceOptions) => InferenceProvider;
//#endregion
//#region packages/harness/src/providers/vercel-gateway.d.ts
interface VercelGatewayInferenceOptions {
  readonly apiKey?: string;
  readonly model?: string;
  readonly contextWindow?: number;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}
declare const vercelGatewayInference: (options?: VercelGatewayInferenceOptions) => InferenceProvider;
//#endregion
//#region packages/harness/src/modules/tools.d.ts
declare const tools: <R = never>(list: ReadonlyArray<Tool<R>>) => Module<"tools", readonly [], readonly [], R>;
interface AgentToolOptions {
  readonly name: string;
  readonly description: string;
  readonly address: string;
  readonly inputSchema?: unknown;
  readonly message?: (input: unknown) => string;
  readonly callId?: (input: unknown, context?: ToolContext) => string;
}
declare const agentTool: (options: AgentToolOptions) => Tool<Router>;
//#endregion
//#region packages/harness/src/modules/nudge.d.ts
interface NudgeOptions extends Omit<Nudge, "placement"> {
  readonly placement?: NudgePlacement;
  readonly version?: string;
}
declare const nudge: (options: NudgeOptions) => Module<`nudge:${string}`, readonly [], readonly [], never>;
//#endregion
export { usedOf as $, systemPrompt as A, Action as At, KEEP_RATIO as B, ToolContext as Bt, transcript as C, Announcement as Ct, usageIn as D, ValueOf as Dt, turnView as E, Signal as Et, inference as F, InferenceProvider as Ft, BudgetOptions as G, selectedInference as Gt, TRIGGER_RATIO as H, Usage as Ht, inferenceState as I, InferenceSelection as It, budgetOf as J, BudgetPhase as K, ContractOptions as L, InferenceState as Lt, DefaultPackOptions as M, AgentToolCall as Mt, defaultPack as N, CustomInferenceOptions as Nt, modelRequest as O, announce as Ot, InferenceOptions as P, Infer as Pt, escalatableOf as Q, contract as R, ModelRequest as Rt, servedLog as S, readSignal as St, turnOf as T, ModuleContext as Tt, morphCompaction as U, customInference as Ut, MorphOptions as V, ToolSpec as Vt, naiveSummary as W, inferWith as Wt, budgetSpent as X, budgetPhase as Y, canRequestBudget as Z, checkpointOf as _, ModuleManifest as _t, tools as a, InboundMessage as at, suffixOf as b, canonicalValue as bt, CloudflareGatewayInferenceOptions as c, TurnOutcome as ct, EXITS as d, defineModule as dt, Agent as et, REQUEST_BUDGET as f, undeclaredEvents as ft, Checkpoint as g, Instruction as gt, keyOf as h, AgentProgram as ht, agentTool as i, BranchOptions as it, toolSurface as j, AgentMessage as jt, renderMessages as k, signal as kt, cloudflareGatewayInference as l, TurnResult as lt, repairText as m, boundaryOf as mt, nudge as n, AgentServices as nt, VercelGatewayInferenceOptions as o, Module as ot, answerErrors as p, CallResult as pt, budget as q, AgentToolOptions as r, AnyModule as rt, vercelGatewayInference as s, ModulePart as st, NudgeOptions as t, AgentOptions as tt, ANSWER as u, createAgent as ut, estimateTokens as v, Nudge as vt, turnHead as w, AnySignal as wt, replyView as x, programId as xt, keepUpTo as y, WITHDRAW_ALL as yt, COMPRESSION_RATIO as z, Tool as zt };