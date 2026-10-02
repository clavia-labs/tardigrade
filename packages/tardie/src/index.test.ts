import { expect, test } from "bun:test"
import { createActor } from "tardie/agent"
import { AtomState, createEventLog, defineActor, initialiseState } from "tardie/core"
import { actor } from "tardie/deprecated"
import { codeMode } from "tardie/deprecated/component/code"
import * as legacyAgent from "tardie/deprecated/agent"
import { definePackage } from "tardie/libraries"

test("public entrypoints expose actor and migration APIs", () => {
  for (const value of [createEventLog, defineActor, initialiseState, definePackage, actor]) {
    expect(typeof value).toBe("function")
  }
  expect(typeof AtomState).toBe("symbol")
  expect(createActor.actorName).toBe("tardie")
  expect(codeMode).toBe(legacyAgent.codeMode)
})

test("public imports hide implementation modules", () => {
  for (const path of ["tardie", "tardie/experimental", "tardie/core/atoms/atom", "tardie/agent/atoms", "tardie/deprecated/core/component/runtime", "tardie/deprecated/core/component/composition/parent"]) {
    expect(() => import.meta.resolve(path)).toThrow()
  }
})
