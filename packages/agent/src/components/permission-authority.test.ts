import { describe, expect, test } from "bun:test"
import { componentContractOf } from "@clavia/tardigrade-core/actor"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { requestPermissionMethod } from "../actor/permission"
import { permissionAuthority, permissionAuthorityKeys } from "./permission-authority"

const received: Event = {
  type: "PermissionRequestReceived",
  id: "permission-1",
  request: "tool-1",
  turn: "run-1",
  tool: "execute",
  action: "write",
  resource: "release.json",
  reason: "publish the release",
  at: 1
}

const eventsOf = (
  component: ReturnType<typeof permissionAuthority>,
  log: ReadonlyArray<Event>
): ReadonlyArray<Event> => {
  const transition = component.derive(log).transitions[0]
  if (transition === undefined) return []
  expect(transition.kind).toBe("intent")
  return transition.kind === "intent" ? transition.events(transition.input, 2) : []
}

describe("permissionAuthority", () => {
  test("records a local decision and then rests", () => {
    const component = permissionAuthority({ decide: (request) => request.deny("needs review") })
    const events = eventsOf(component, [received])

    expect(events).toEqual([{
      type: "PermissionRequestDecided",
      callId: "permission-1",
      granted: false,
      reason: "needs review",
      at: 2
    }])
    expect(permissionAuthorityKeys.keyOf(events[0]!)).toBe("pa:permission-1")
    expect(component.derive([received, ...events]).transitions).toEqual([])
    expect(componentContractOf(component).handles).toEqual([{
      method: requestPermissionMethod,
      handling: "local"
    }])
  })

  test("turns an invalid decision into a durable method failure", () => {
    const component = permissionAuthority({ decide: () => ({ granted: false }) as never })
    const events = eventsOf(component, [received])

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(expect.objectContaining({
      type: "PermissionRequestFailed",
      callId: "permission-1",
      error: expect.stringContaining("PermissionDecision")
    }))
  })

  test("a manual authority declares external handling and schedules no decision", () => {
    const component = permissionAuthority.manual()

    expect(component.derive([received]).transitions).toEqual([])
    expect(componentContractOf(component).handles).toEqual([{
      method: requestPermissionMethod,
      handling: "external"
    }])
  })
})
