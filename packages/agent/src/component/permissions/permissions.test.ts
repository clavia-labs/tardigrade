import { replayProjection } from "@clavia/tardigrade-core/projection"
import { withResponse } from "@clavia/tardigrade-core/component"
import { component } from "@clavia/tardigrade-core/actor"
import { Context } from "effect"
import { expect, expectTypeOf, test } from "bun:test"
import { testMachineOf as machineOf } from "../../../fixtures/component"
import { AGENT_VIEW_ALGEBRA } from "../view"
import { permissions } from "./index"

class ToolData extends Context.Service<ToolData, { readonly name: string }>()("test/ToolData") {}
const permissionOptions = {
  request: () => undefined,
  onDenied: () => undefined
}

test("permissions initialize dependent children with host data", () => {
  const initialized: string[] = []
  const child = component({
    name: "dependent-tools",
    dependencies: [ToolData],
    initial: (_children, [data]) => {
      initialized.push(data.name)
      return data
    },
    step: (state) => state,
    output: (state) => ({
      view: {
        ...AGENT_VIEW_ALGEBRA.empty,
        tools: [
          {
            spec: {
              name: state.name,
              description: "read",
              inputSchema: {}
            }
          }
        ],
        calls: [],
        pendingCalls: []
      },
      transitions: []
    })
  })
  const governed = permissions(child, permissionOptions)
  expect(initialized).toEqual([])
  const machine = machineOf(governed)
  expect(() => machine.initial(Context.empty())).toThrow("test/ToolData")
  const state = machine.initial(Context.make(ToolData, { name: "read" }))
  expect(initialized).toEqual(["read"])
  expect(machine.output(state).view.tools.map((tool) => tool.spec.name)).toEqual(["read"])
})


test("permissions governs typed non-tool work and preserves the child's view", () => {
  const child = component({
    name: "publication",
    initial: (): import("@clavia/tardigrade-core/component").ComponentOutput<{ title: string } & typeof AGENT_VIEW_ALGEBRA.empty, never, { published: boolean }> => ({
      view: { ...AGENT_VIEW_ALGEBRA.empty, title: "Draft" }, transitions: []
    }),
    step: (state, event, context) => {
      if (event.type === "PublishRequested") {
        const work = context.intent("publish", { type: "Published", title: state.view.title })
        return { ...state, transitions: [withResponse(work, (result: { published: boolean }) =>
          context.intent("response", { type: "PublicationSettled", ...result }))] }
      }
      return event.type === "PublicationSettled" || event.type === "Published" ? { ...state, transitions: [] } : state
    },
    output: state => state
  })
  const wrapper = permissions(child, {
    request: (_work, view) => ({ action: "publish", resource: view.title, reason: "Release" }),
    onDenied: (_reason, respond) => {
      expectTypeOf<Parameters<typeof respond>[0]>().toEqualTypeOf<{ published: boolean }>()
      return respond({ published: false })
    }
  })
  const machine = machineOf(wrapper)
  const log = [{ type: "PublishRequested" }]
  const held = replayProjection(machine, log)
  expect(held.transitions).toEqual([])
  expect(held.view.title).toBe("Draft")
  const key = held.view.permissions[0]!.key
  const denied = replayProjection(machine, [...log, {
    type: "PermissionRequestDecided", callId: `permission/${key}`, granted: false
  }])
  const completion = denied.transitions[0]!
  if (completion.kind !== "intent") throw new Error("expected a child response")
  const result = completion.events(completion.input, 0)
  expect(result).toMatchObject([{ type: "PublicationSettled", published: false }])
  expect(replayProjection(machine, [...log, ...result]).transitions).toEqual([])
  const allowed = replayProjection(machine, [...log, {
    type: "PermissionRequestDecided", callId: `permission/${key}`, granted: true
  }])
  expect(allowed.transitions[0]!.key).toBe(key)
})
