import { Atom } from "effect/unstable/reactivity"
import { atom } from "@clavia/tardigrade-experimental-core"

// systemPrompt creates a labeled source for the agent's system instructions.
export const systemPrompt = (text: string) => {
  const source = atom(text)
  return Object.assign(source, { label: Atom.withLabel(source, "system").label! })
}
