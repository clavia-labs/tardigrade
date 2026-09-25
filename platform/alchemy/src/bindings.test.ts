import { describe, expect, test } from "bun:test"

import { tardigradeBindingsWith, type DurableObjectFactory } from "./bindings"

const recordingCloudflare = (calls: string[]): DurableObjectFactory => ({
  DurableObject: (name: string) => {
    calls.push(name)
    return { kind: "Cloudflare.DurableObject", name, className: name }
  },
})

describe("tardigradeBindingsWith", () => {
  test("passes the exported class name, which is what alchemy binds", () => {
    const calls: string[] = []
    const bindings = tardigradeBindingsWith(recordingCloudflare(calls))
    expect(calls).toEqual(["ActorDO", "ThreadDO"])
    expect(Object.keys(bindings).sort()).toEqual(["ACTORS", "THREADS"])
    expect(bindings.ACTORS.name).toBe("ActorDO")
    expect(bindings.THREADS.name).toBe("ThreadDO")
  })

  test("carries re-exported class names through", () => {
    const calls: string[] = []
    const bindings = tardigradeBindingsWith(recordingCloudflare(calls), {
      actorClassName: "SupervisorDO",
      threadClassName: "SessionDO",
    })
    expect(calls).toEqual(["SupervisorDO", "SessionDO"])
    expect(bindings.ACTORS.name).toBe("SupervisorDO")
    expect(bindings.THREADS.name).toBe("SessionDO")
  })
})
