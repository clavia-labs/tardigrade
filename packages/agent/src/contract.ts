import { Validator } from "@cfworker/json-schema"
import type { Event } from "@flamecast/core/event"

// The turn's output contract. A declared schema is checked here before an answer becomes the
// terminal: a model can produce a well-formed tool call whose arguments still miss the schema,
// and an unchecked answer surfaces as a TypeError wherever the fields are read. The platform
// builds the answer tool from the schema; the tools reactor judges answers against it.

// outputSchemaOf reads the current turn's declared schema; the last message heads the turn.
export const outputSchemaOf = (trajectory: ReadonlyArray<Event>): unknown => {
  for (let i = trajectory.length - 1; i >= 0; i--) {
    const e = trajectory[i]!
    if (e.type === "MessageReceived") return (e as { output?: unknown }).output
  }
  return undefined
}

// answerErrors says why an answer fails its schema, one line each; empty when it conforms or
// nothing was declared.
export const answerErrors = (schema: unknown, answer: unknown): ReadonlyArray<string> => {
  if (schema === undefined || schema === null || typeof schema !== "object") return []
  try {
    const result = new Validator(schema as never).validate(answer === undefined ? {} : answer)
    return result.valid ? [] : result.errors.map((e) => `${e.instanceLocation || "/"}: ${e.error}`)
  } catch (e) {
    // The schema is author-written and stored opaque, so one the validator cannot build (an
    // unresolvable `$ref`, say) throws at construction. That surfaces as a contract error the
    // model can read and repair.
    return [`invalid schema: ${e instanceof Error ? e.message : String(e)}`]
  }
}

// repairText is the message the model receives when its answer misses the schema. The errors are
// the whole message.
export const repairText = (errors: ReadonlyArray<string>): string =>
  `Your answer did not match this turn's output schema:\n${errors.map((e) => `- ${e}`).join("\n")}\n` +
  `Call the answer tool again with arguments that satisfy the schema. Send values in their declared types: ` +
  `an array is a JSON array, never a string holding one.`
