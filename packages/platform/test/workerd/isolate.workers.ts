import { env } from "cloudflare:workers"
import { expect, test } from "vitest"
import { Effect } from "effect"
import { Isolate, type IsolateCall } from "@clavia/tardigrade-core"
import { workerLoaderIsolate } from "../../src/cloudflare"

const loader = (env as unknown as { LOADER: WorkerLoader }).LOADER

for (const transport of ["capability", "replay"] as const) test(`worker loader isolate resumes code with package call results (${transport})`, async () => {
  const calls: IsolateCall[] = []
  const result = await Effect.runPromise(Effect.gen(function* () {
    const isolate = yield* Isolate
    return yield* isolate.run({
      code: `const sum = await math.add({ left: 2, right: 3 })\nconsole.log("sum", sum)\nreturn { sum, now: Date.now() }`,
      packages: { math: ["add"] },
      ambient: { at: 1234, seed: "isolate" },
    }, call => Effect.sync(() => {
      calls.push(call)
      const input = call.input as { readonly left: number; readonly right: number }
      return input.left + input.right
    }))
  }).pipe(Effect.provide(workerLoaderIsolate(loader, { transport }))))
  expect(result).toEqual({ result: { sum: 5, now: 1234 }, logs: ["sum 5"] })
  expect(calls).toEqual([{ ordinal: 0, package: "math", method: "add", input: { left: 2, right: 3 } }])
})

test("worker loader isolate reserves ambient binding names", async () => {
  const failure = await Effect.runPromise(Effect.flip(Effect.gen(function* () {
    const isolate = yield* Isolate
    return yield* isolate.run({ code: "return 0", packages: { Math: ["max"] }, ambient: { at: 0, seed: "isolate" } }, () => Effect.succeed(null))
  }).pipe(Effect.provide(workerLoaderIsolate(loader)))))
  expect(failure).toBe("Reserved isolate binding: Math")
})
