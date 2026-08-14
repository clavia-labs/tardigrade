import type { NativeTool } from "./infer"
import { budget, type BudgetOptions } from "./modules/budget"
import { morphCompaction, type MorphOptions } from "./modules/compaction"
import { contract, type ContractOptions } from "./modules/contract"
import { inference, type InferenceOptions } from "./modules/inference"
import { nativeTools } from "./modules/native-tools"

export interface DefaultPackOptions<R = never> {
  readonly inference?: InferenceOptions
  readonly nativeTools?: ReadonlyArray<NativeTool<R>>
  readonly budget?: BudgetOptions
  readonly contract?: ContractOptions
  readonly compaction?: MorphOptions
}

export const defaultPack = <R = never>(options: DefaultPackOptions<R> = {}) =>
  [
    inference(options.inference),
    nativeTools(options.nativeTools ?? []),
    budget(options.budget),
    contract(options.contract),
    morphCompaction(options.compaction)
  ] as const
