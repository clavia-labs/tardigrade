import { expect, test } from "bun:test"
import { Schema } from "effect"
import { component, defineActor, interactionScope, type InteractionRequest } from "@clavia/tardigrade-core/actor"
import { legacyActorMethod } from "@clavia/tardigrade-core/actor/method-compat"
import type { Event } from "@clavia/tardigrade-core/event"
import { prepareInvocation } from "@clavia/tardigrade-core/interaction"
import { methodIngressKeyOf } from "@clavia/tardigrade-core/interaction/invocation"
import { actorRuntimeOf } from "@clavia/tardigrade-core/runtime"
import type { TransitionContext } from "@clavia/tardigrade-core/transition/transition"
import { createHost } from "@clavia/tardigrade-host/host"
import { createBunHost } from "@clavia/tardigrade-bun/host"

type Payload = { readonly requestId: string; readonly value: number }
type Pending = { readonly context: TransitionContext; readonly tag: string; readonly request: InteractionRequest }

const fixture = () => {
  const parentScope = interactionScope("parent")
  const childScope = interactionScope("child")
  const reported = parentScope.define<Payload>((payload, origin) => ({ type: "Reported", ...payload, ...origin }))
  const child = component({
    name: "child",
    input: { calculate: childScope.define<Payload>((payload, origin) => ({ type: "CalculationRequested", ...payload, ...origin })) },
    initial: (): Pending | undefined => undefined,
    step: (state, event, context) => event.type === "CalculationRequested"
      ? { context, tag: "report", request: reported({ requestId: String(event.requestId), value: Number(event.value) * 2 }) }
      : state?.context.matches(state.tag, event) ? undefined : state,
    output: state => ({ view: undefined, transitions: state === undefined ? [] : [state.context.interaction(state.tag, state.request)] })
  })
  const wrapper = component({
    name: "wrapper", input: child.input, children: child,
    initial: () => undefined, step: () => undefined,
    output: (_state, bound) => bound.output()
  })
  const parent = component({
    name: "parent", input: { reported }, children: wrapper,
    initial: (): { readonly event: Event; readonly context: TransitionContext } | undefined => undefined,
    step: (state, event, context) => event.type === "Started" || event.type === "Reported"
      ? { event, context }
      : state?.context.matches("send", event) || state?.context.matches("complete", event) ? undefined : state,
    output: (state, bound) => ({
      view: undefined,
      transitions: [...bound.output().transitions, ...(state === undefined ? [] : [state.event.type === "Started"
        ? state.context.interaction("send", wrapper.input.calculate({ requestId: String(state.event.id), value: Number(state.event.value) }))
        : state.context.intent("complete", { type: "Completed", id: state.event.requestId, value: state.event.value })])]
    })
  })
  const run = legacyActorMethod({
    input: Schema.Struct({ value: Schema.Finite }), output: Schema.Finite,
    event: ({ invocation, input, at }): Event => ({ type: "Started", id: invocation.id, value: input.value, at }),
    state: (events, invocation) => {
      const done = events.find(event => event.type === "Completed" && event.id === invocation.id)
      return done === undefined ? { status: "pending" } : { status: "completed", output: Number(done.value) }
    }
  })
  return { actor: defineActor("dummy", { run }, [parent]), run }
}

const coordinate = { actor: "dummy", instance: "test", thread: "main" }
const protocol = (events: ReadonlyArray<Event>) => events.filter(event =>
  ["Started", "CalculationRequested", "Reported", "Completed"].includes(event.type))

for (const backend of ["memory", "sqlite"] as const) {
  test(`stable inputs make a round trip through dummy components and recover at every recorded boundary (${backend})`, async () => {
    const open = async () => {
      const { actor, run } = fixture()
      const options = {
        actorName: coordinate.actor, actorInstance: coordinate.instance, actorFor: () => actor,
        keyOf: (event: Event) => methodIngressKeyOf(event) ?? actorRuntimeOf(actor).keyOf(event)
      }
      const host = backend === "memory" ? createHost(options)
        : await createBunHost({ ...options, database: ":memory:", workspaceSql: false })
      return { host, run, close: async () => { if ("close" in host) await host.close() } }
    }
    const first = await open()
    let history: ReadonlyArray<Event>
    try {
      await first.host.allocate({ kind: "root", coordinate })
      await first.host.commitRoot(first.host.self("main"), prepareInvocation({
        reference: { target: coordinate, invocation: { method: "run", id: "example", epoch: 0 } },
        method: first.run, input: { value: 21 }, at: 1
      }).event)
      await first.host.drive()
      history = await first.host.read("main")
      expect(protocol(history).map(event => event.type)).toEqual(["Started", "CalculationRequested", "Reported", "Completed"])
      expect(protocol(history).at(-1)).toMatchObject({ id: "example", value: 42 })
    } finally { await first.close() }

    for (let cut = 1; cut <= history.length; cut++) {
      if (!protocol([history[cut - 1]!]).length) continue
      const recovered = await open()
      try {
        await recovered.host.seed("main", history.slice(0, cut))
        await recovered.host.wake("main")
        const completed = await recovered.host.read("main")
        expect(protocol(completed).map(({ type, id, requestId, value }) => ({ type, id, requestId, value })))
          .toEqual(protocol(history).map(({ type, id, requestId, value }) => ({ type, id, requestId, value })))
        await recovered.host.wake("main")
        expect(await recovered.host.read("main")).toEqual(completed)
      } finally { await recovered.close() }
    }
  })
}
