import { expect, test } from "bun:test"
import { componentPurityViolations } from "./component-purity"

const file = "packages/agent/src/component/example.ts"
const apis = (source: string, path = file) => componentPurityViolations(path, source).map((finding) => finding.api)

test("rejects clocks, randomness, I/O, environment reads, and effect execution", () => {
  expect(apis(`import { Effect as Fx } from "effect"
    import { readFile as read } from "node:fs/promises"
    Date.now(); Math.random(); fetch('/api'); Fx.runPromise(task); read('file'); process.env.MODE;
    new Date(); new WebSocket('url'); import('node:fs');`))
    .toEqual(["Date.now", "Math.random", "fetch", "Effect.runPromise", "io:node:fs/promises.readFile", "process.env", "Date", "WebSocket", "dynamic import"])
})

test("follows local aliases and destructured effect runners", () => {
  expect(apis(`import { Effect } from "effect"; const clock = Date.now;
    const { runSync: execute } = Effect; const { random: roll } = Math;
    clock(); execute(work); roll(); globalThis.fetch('/api');`))
    .toEqual(["Date.now", "Effect.runSync", "Math.random", "globalThis.fetch"])
})

test("component factories outside component modules establish a purity boundary", () => {
  const source = `import { component as define } from '@clavia/tardigrade-core/component';
    const timestamp = () => Date.now();
    fetch('/bootstrap');
    define({ initial: () => 0, step: state => state, output: () => ({ view: { timestamp: timestamp(), random: Math.random() }, transitions: [] }) });`
  expect(apis(source, "apps/server/src/actor.ts")).toEqual(["Date.now", "Math.random"])
})

test("allows deferred effect bodies while rejecting eager argument evaluation", () => {
  expect(apis(`import { Effect } from 'effect';
    context.effect('run', { input: Date.now(), act: () => fetch('/api') });
    Effect.sync(() => Date.now());
    Effect.gen(function*() { yield* Effect.promise(() => fetch('/api')); });
    Effect.sync(Date.now());`)).toEqual(["Date.now", "Date.now"])
})

test("an arbitrary act property does not bypass the boundary", () => {
  expect(apis(`const object = { act: () => fetch('/api') };`)).toEqual(["fetch"])
})

test("permits pure computation, fresh local mutation, and deterministic dates", () => {
  expect(apis(`const next = new Map(); next.set('count', 1);
    const at = new Date(0).getTime(); Math.max(1, 2);
    const text = "Date.now()"; // fetch('/api')
    const act = () => ({ view: at, transitions: [] });`)).toEqual([])
})

test("named deferred handlers remain allowed but direct evaluation is checked", () => {
  const source = `const work = () => fetch('/api');
    context.effect('run', { input: undefined, act: work });`
  expect(apis(source)).toEqual([])
  expect(apis(`${source}\nwork();`)).toEqual(["fetch"])
})

test("clock aliases passed into deferred constructors are allowed until called eagerly", () => {
  const source = `import { Effect } from 'effect'; function now() { return Date.now() }
    Effect.sync(now);`
  expect(apis(source)).toEqual([])
  expect(apis(`${source}\nnow();`)).toEqual(["Date.now"])
})
