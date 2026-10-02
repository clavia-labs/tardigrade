import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { atom, type Atom } from "@clavia/tardigrade-core"

// systemPrompt joins static text and reactive instruction blocks, omitting empty blocks.
export const systemPrompt = (...blocks: readonly (string | Atom<string>)[]) => {
  const source = atom(get => blocks.map(block => typeof block === "string" ? block : get(block)).filter(block => block.trim().length > 0).join("\n\n"))
  return Object.assign(source, { label: NativeAtom.withLabel(source, "system").label! })
}
