import { Effect } from "effect"
import { sandboxReturned } from "@clavia/tardigrade-code/sandbox/service"
import { workerLoaderSandboxServiceFor } from "../src/sandbox"

export const ISOLATED_CALLBACK_TRANSPORT = {
  executions: 20,
  callsPerExecution: 3
} as const

export interface IsolatedCallbackTransportResult {
  readonly executions: number
  readonly packageCalls: number
  readonly callbackIngress: number
  readonly resultMarkers: number
}

export interface IsolatedCallbackTransportOptions {
  readonly modeledExecutionLimit?: number
}

export const isolatedCallbackTransportBody = `
  const first = await tools.mark({ step: 0 })
  const second = await tools.mark({ step: 1 })
  const third = await tools.mark({ step: 2 })
  return [first, second, third]
`

export interface ReplaySequenceResult {
  readonly result: unknown
  readonly observed: ReadonlyArray<{ readonly ordinal: number; readonly value: number }>
}

// replaySequenceWith runs the replay sequence shared by the workerd and Celld runtime suites.
export const replaySequenceWith = async (loader: WorkerLoader): Promise<ReplaySequenceResult> => {
  const observed: Array<{ readonly ordinal: number; readonly value: number }> = []
  const sandbox = workerLoaderSandboxServiceFor(loader, { transport: "replay" })
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
