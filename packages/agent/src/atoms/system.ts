import { promptBoundary, type PromptContent } from "@clavia/tardigrade-model/prompt"
import { Atom as NativeAtom } from "effect/reactivity"
import { atom, type Atom } from "@clavia/tardigrade-core"

// systemPrompt preserves static and reactive text parts, omitting blank string inputs.
export const systemPrompt = (...blocks: readonly (PromptContent | Atom<PromptContent>)[]) => {
  const source = atom(get => blocks.flatMap(block => {
    const content = NativeAtom.isAtom(block) ? get(block) : block
    return promptBoundary(content)
  }))
  return Object.assign(source, { label: NativeAtom.withLabel(source, "system").label! })
}
