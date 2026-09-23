import { expect, test } from "bun:test"
import { alarmSet } from "@clavia/tardigrade-core/alarm"
import { replayProjection } from "@clavia/tardigrade-core/projection"
import { alarm } from "@clavia/tardigrade-code/package/alarm"
import { testMachineOf as machineOf } from "@clavia/tardigrade-agent/fixtures/component"
import { testModelData } from "../fixtures/model"
import { codeMode } from "../src/component/code/index"
import { tools } from "../src/component/tool/index"
import { infer, type InferInputs } from "../src/component/infer"
import { nativeOutput } from "../src/component/native-output"
import { budget } from "../src/component/budget"

const wake = [alarmSet("alarms/call-1", 50, "Check the job"), { type: "AlarmFired", scheduledFor: 50, at: 53 }]

for (const mode of ["code", "tools"] as const) {
  test(`infer supplies messages through budget and ${mode}, and alarm replay starts one turn`, () => {
    let suppliedMessage!: InferInputs["message"]
    const root = infer(({ message }) => {
      suppliedMessage = message
      const pkg = alarm({ onFired: alarm => message({ text: alarm.note }) })
      return [budget(mode === "code" ? codeMode([pkg]) : tools([pkg]), {
        limit: 12, usage: () => 0, onExhausted: (reason, settle) => settle({ error: reason })
      }), nativeOutput]
    })
    expect(root.input.message).toBe(suppliedMessage)
    const output = replayProjection(machineOf(root), wake, testModelData)
    if (mode === "code") expect(output.view.system.join("\n")).toContain("alarm.set")
    else expect(output.view.tools.map(entry => entry.spec.name)).toEqual(["alarm_set", "alarm_cancel"])
    const firing = output.transitions.find(work => work.kind === "intent")!
    expect(firing).toBeDefined()
    if (firing.kind !== "intent") throw new Error("expected firing intent")
    const message = firing.events(firing.input, 54)[0]!
    expect(message).toMatchObject({ type: "MessageReceived", id: firing.key, text: "Check the job" })
    const after = replayProjection(machineOf(root), [...wake, message], testModelData)
    expect(after.transitions.some(work => work.key === firing.key)).toBe(false)
    expect(after.transitions.some(work => work.kind === "effect" && work.invocation?.method === "message" && work.invocation.id === message.id)).toBe(true)
    expect(replayProjection(machineOf(root), wake, testModelData).transitions[0]!.key).toBe(firing.key)
  })
}

test("an infer capability cannot escape into another infer", () => {
  let escaped!: InferInputs["message"]
  infer(({ message }) => { escaped = message; return [nativeOutput] })
  const other = infer([tools([alarm({ onFired: alarm => escaped({ text: alarm.note }) })]), nativeOutput])
  expect(() => replayProjection(machineOf(other), wake, testModelData)).toThrow("not supplied")
})
