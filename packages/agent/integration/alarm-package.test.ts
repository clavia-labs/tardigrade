import { expect, test } from "bun:test"
import { alarmSet } from "@clavia/tardigrade-core/alarm"
import { replayProjection } from "@clavia/tardigrade-core/projection"
import { alarms } from "@clavia/tardigrade-code/package/alarm"
import { testMachineOf as machineOf } from "@clavia/tardigrade-agent/fixtures/component"
import { codeMode } from "../src/component/code/index"
import { tools } from "../src/component/tool/index"

const wake = [alarmSet("alarms/call-1", 50, "Check the job"), { type: "AlarmFired", scheduledFor: 50, at: 53 }]

test("the same alarms package serves code mode and package tools", () => {
  const pkg = alarms()
  const code = replayProjection(machineOf(codeMode([pkg])), wake)
  const tool = replayProjection(machineOf(tools([pkg])), wake)
  expect(code.view.system[0]).toContain("alarms.set")
  expect(code.view.system[0]).toContain("alarms.cancel")
  expect(tool.view.tools.map((entry) => entry.spec.name)).toEqual(["alarms_set", "alarms_cancel"])
  for (const output of [code, tool]) {
    expect(output.transitions.some((work) => work.kind === "intent" &&
      work.events(work.input, 54).some((event) => event.type === "MessageReceived" && event.text === "Check the job"))).toBe(true)
  }
})
