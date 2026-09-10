import { expect, test } from "bun:test"
import * as root from "tardie"
import * as core from "tardie/core"
import * as agent from "tardie/agent"
import * as code from "tardie/code"
import { codeMode } from "tardie/component/code"
import { codeMode as scopedCodeMode } from "tardie/agent/component/code"
import { Park } from "tardie/code/execution/errors"

test("public scopes retain the compatibility exports", () => {
  for (const scope of [core, agent, code]) {
    for (const [name, value] of Object.entries(scope)) {
      expect(root[name as keyof typeof root]).toBe(value)
    }
  }
  expect(codeMode).toBe(agent.codeMode)
  expect(scopedCodeMode).toBe(agent.codeMode)
  expect("infer" in core).toBe(false)
  expect("defineActor" in agent).toBe(false)
  expect(core.externalReplyReceived({ id: "native:ready", at: 1 })).toEqual({
    type: "ExternalReplyReceived",
    id: "native:ready",
    at: 1
  })
  expect(new Park({ callId: "call", awaiting: "native:ready" }).awaiting).toBe("native:ready")
})
