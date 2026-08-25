import { Effect } from "effect"
import { sandboxReturned } from "@clavia/tardigrade-code/sandbox"
import { cloudflareSandboxServiceFor } from "../src/sandbox"

export interface ReplaySequenceResult {
  readonly result: unknown
  readonly observed: ReadonlyArray<{ readonly ordinal: number; readonly value: number }>
}

// replaySequenceWith runs the replay sequence shared by the workerd and Celld runtime suites.
export const replaySequenceWith = async (loader: WorkerLoader): Promise<ReplaySequenceResult> => {
  const observed: Array<{ readonly ordinal: number; readonly value: number }> = []
  const sandbox = cloudflareSandboxServiceFor(loader, () => {
    throw new Error("replay transport must not open a capability")
  }, { transport: "replay" })
  const result = await Effect.runPromise(sandbox.run(
    `const first = await tools.double({ value: 3 })
    const pair = await Promise.all([
      tools.double({ value: first }),
      tools.double({ value: 5 })
    ])
    return pair`,
    {
      tools: {
        double: async (input, ordinal) => {
          const value = (input as { readonly value: number }).value
          observed.push({ ordinal, value })
          return sandboxReturned(value * 2)
        }
      }
    }
  ))
  return { result, observed }
}
