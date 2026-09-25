import { Context, Effect } from "effect"
import { component, composeComponents, legacyComponent } from "@clavia/tardigrade-core/actor"
import { testMachineOf as machineOf } from "../../../fixtures/component"
import { replayState, replayProjection } from "@clavia/tardigrade-core/projection"
import { describe, expect, expectTypeOf, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { codeMode, CODE_SYSTEM, codeSystemFor } from "./index"
import {
  CODE_VIEW_ALGEBRA,
  definePackage,
  type Package
} from "@clavia/tardigrade-code/package/definition"
import { fetchPackage } from "@clavia/tardigrade-code/package/fetch"
import type { KeyValueStore } from "effect/unstable/persistence"
import type { AgentComponent } from "../view"
import { bindTransitionContext } from "@clavia/tardigrade-core/transition/transition"

describe("code cancellation", () => {
  test("the component settles one open execution before its invocation terminal", () => {
    const component = codeMode([])
    const transition = (machineOf(component).output(replayState(machineOf(component), [
      { type: "CodeDispatched", execId: "exec-1", code: "work()", turn: "m1", at: 1 }
    ] as ReadonlyArray<Event>)).interactions?.cancel?.({
      request: "x1",
      invocation: { method: "message", id: "m1", epoch: 0 },
      cause: "requested",
      reason: "operator stopped it"
    }) ?? [])[0]

    expect(transition).toMatchObject({ kind: "intent", key: JSON.stringify([1, "code.execution", "execute"]) })
    if (transition?.kind !== "intent") throw new Error("Expected cancellation intent")
    expect(transition.events(transition.input, 2)).toMatchObject([{
      type: "CodeSettled",
      execId: "exec-1",
      error: "cancelled: operator stopped it",
      turn: "m1",
      at: 2
    }])
  })


})


class PackageData extends Context.Service<PackageData, { readonly label: string }>()("test/PackageData") {}

test("codeMode initializes dependent children only during activation", () => {
  const initialized: string[] = []
  const child = component({
    name: "dependent-packages",
    dependencies: [PackageData],
    initial: (_children, [data]) => { initialized.push(data.label); return undefined },
    step: state => state,
    output: () => ({ view: { packages: [], calls: [], pendingCalls: [] }, transitions: [] })
  })
  const code = codeMode([child])
  expect(initialized).toEqual([])
  const machine = machineOf(code)
  expect(() => machine.initial(Context.empty())).toThrow("test/PackageData")
  const state = machine.initial(Context.make(PackageData, { label: "host" }))
  expect(initialized).toEqual(["host"])
  expect(machine.output(state).view.tools.map(tool => tool.spec.name)).toEqual(["execute"])
})


// Ticker is a service no assembled agent provides, so a component that requires it is
// distinguishable at compile time from one that does not.
class Ticker extends Context.Service<Ticker, string>()("agent/test/Ticker") {}

describe("codeMode authoring", () => {
  test("codeMode takes a system fragment, and the empty scope renders the exported default", () => {
    const overridden = replayProjection(machineOf(codeMode([], { system: events => `the packages in scope are:\n${events.length}` })), [{ type: "PackageInstalled" }]).view
    expect(overridden.system[0]).toBe("the packages in scope are:\n1")
    expect(replayProjection(machineOf(codeMode()), []).view.system[0]).toBe(CODE_SYSTEM)
  })

  test("a mounted package names itself in the system fragment", () => {
    // The model is told what the code can name, from the same values the code reactor mounts:
    // package prose followed by each documented input and output shape (component/code/index.ts,
    // codeSystemFor).
    const notes: Package = definePackage({
      name: "notes",
      description: "the team's notes",
      docs: {
        put: {
          description: "Save one note.",
          input: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"]
          },
          output: {
            type: "object",
            properties: { ok: { type: "boolean" }, error: { type: "string" } },
            required: ["ok"]
          }
        }
      },
      methods: {
        put: () => Effect.succeed(null)
      }
    })
    const system = replayProjection(machineOf(codeMode([notes])), []).view.system[0]!
    expect(system).toContain("notes: the team's notes")
    expect(system).toContain("notes.put({text: string}) -> {ok: boolean, error?: string}: Save one note.")
    expect(system).not.toContain("none")
    // An explicit fragment still wins over the component output.
    expect(replayProjection(machineOf(codeMode([notes], { system: "my own scope" })), []).view.system[0]).toBe("my own scope")
  })

  test("package docs show fetch input and output shapes", () => {
    const system = codeSystemFor([fetchPackage()])
    expect(system).toContain("The execute tool runs an async JavaScript body")
    expect(system).toContain("const value = await package.method(input); return value")
    expect(system).toContain("fetch.get({url: string, headers?: object})")
    expect(system).toContain("-> {status?: number, headers?: object, body?: string, truncated?: boolean, error?: string}")
  })

  test("codeMode composes nested code components and preserves their work", () => {
    const notes = definePackage({
      name: "notes",
      description: "the team's notes",
      methods: {
        read: () => Effect.succeed(null)
      }
    })
    const search = definePackage({
      name: "search",
      description: "the team's index",
      methods: {
        find: () => Effect.succeed(null)
      }
    })
    const upkeep = legacyComponent({
      name: "upkeep",
      derive: (events) => ({
        view: { packages: [], calls: [], pendingCalls: [] },
        transitions: events.filter((event) => event.type === "DailyRequested").map((event) =>
          bindTransitionContext(event, "upkeep").effect("refresh", {
            input: undefined, act: () => Effect.succeed({ type: "CodeUpkeepCompleted", id: "daily" })
          }))
      })
    })
    const nested = composeComponents("knowledge", CODE_VIEW_ALGEBRA, [notes, upkeep, search])
    const component = codeMode([nested])
    const derived = replayProjection(machineOf(component), [{ type: "DailyRequested" }])

    expect(derived.view.system[0]).toContain("notes: the team's notes\nsearch: the team's index")
    expect(derived.transitions.map((transition) => transition.key)).toEqual([JSON.stringify([1, "upkeep", "refresh"])])
  })

  test("codeMode rejects duplicate package names at activation", () => {
    const left = definePackage({ name: "notes", description: "left", methods: {} })
    const right = definePackage({ name: "notes", description: "right", methods: {} })
    expect(() => composeComponents("duplicate", CODE_VIEW_ALGEBRA, [left, right])).toThrow("duplicate component identity")
  })

  test("a mounted package's requirements ride the component's type", () => {
    // Compile-time only: the const type parameter infers the component tuple, so R is the spill
    // store plus exactly what the listed packages require. A widened
    // `ReadonlyArray<Package<Ticker>>` would fail the empty-scope assertions below
    // (component/code/index.ts, codeMode).
    const ticker: Package<Ticker> = definePackage({
      name: "ticker",
      description: "the clock",
      methods: {
        now: () =>
          Effect.gen(function* () {
            return { tick: yield* Ticker }
          })
      }
    })
    const scoped: AgentComponent<KeyValueStore.KeyValueStore | Ticker> = codeMode([ticker])
    expectTypeOf(codeMode([ticker])).not.toMatchTypeOf<AgentComponent<KeyValueStore.KeyValueStore>>()
    const empty: AgentComponent<KeyValueStore.KeyValueStore> = codeMode([])
    const bare: AgentComponent<KeyValueStore.KeyValueStore> = codeMode()
    expect([scoped.name, empty.name, bare.name]).toEqual(["code", "code", "code"])
  })
})
