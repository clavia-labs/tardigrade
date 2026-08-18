import type { NativeTool } from "./infer"
import { budget, type BudgetOptions } from "./modules/budget"
import { morphCompaction, type MorphOptions } from "./modules/compaction"
import { contract, type ContractOptions } from "./modules/contract"
import { inference, type InferenceOptions } from "./modules/inference"
import { nativeTools } from "./modules/native-tools"
import { truncationNudge, type TruncationNudgeOptions } from "./modules/truncation"

export interface DefaultPackOptions<R = never> {
  // Required, because `inference` is: a pack that answers with a model has to say which model and
  // what it accepts, and there is no figure this file could supply on its behalf.
  readonly inference: InferenceOptions
  readonly nativeTools?: ReadonlyArray<NativeTool<R>>
  readonly budget?: BudgetOptions
  readonly contract?: ContractOptions
  readonly compaction?: MorphOptions
  // What to say to a model whose answer was cut at the output ceiling. The pack ships wording so a
  // truncated answer resumes out of the box; an agent that would rather say something else composes
  // its modules by hand or restates these two.
  readonly truncation?: TruncationNudgeOptions
}

export const defaultPack = <R = never>(options: DefaultPackOptions<R>) =>
  [
    // Mid-turn compaction on, because this pack ships the compaction module that answers it. A
    // caller who states it wins, so an agent that wants the plain loop can still say so.
    inference({ compactMidTurn: true, ...options.inference }),
    nativeTools(options.nativeTools ?? []),
    budget(options.budget),
    contract(options.contract),
    morphCompaction(options.compaction),
    ...truncationNudge(options.truncation)
  ] as const
