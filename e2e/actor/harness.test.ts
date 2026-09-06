import { expect, spyOn, test } from "bun:test"
import { actor, agentMethods, infer, nativeOutput } from "tardie"
import { actorScenario, ROOT_THREAD, TEST_MODEL } from "./harness"

test("scenario ingress allocates before delivery and uses the declared method protocol", async () => {
  const definition = actor({ name: "scenario", methods: agentMethods,
    components: [infer([nativeOutput], TEST_MODEL)] })
  const scenario = actorScenario(definition, async () => ({ kind: "complete", output: "hello Rick" }))
  const commit = scenario.host.commitRoot
  const delivery = spyOn(scenario.host, "commitRoot").mockImplementation(async (address, event) => {
    const events = scenario.host.read(ROOT_THREAD)
    expect(events.filter((entry) => entry.type === "ThreadCreated")).toHaveLength(1)
    expect(event.call).toMatchObject({ invocation: { method: "message", epoch: 0 } })
    await commit(address, event)
  })
  try {
    const first = await scenario.run("hello")
    const second = await scenario.run("hello again")
    expect(first.output).toBe("hello Rick")
    expect(second.output).toBe("hello Rick")
    expect(second.turn).not.toBe(first.turn)
    expect(delivery).toHaveBeenCalledTimes(2)
    expect(scenario.host.read(ROOT_THREAD).filter((event) => event.type === "ThreadCreated")).toHaveLength(1)
  } finally {
    delivery.mockRestore()
  }
})
