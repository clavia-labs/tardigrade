import { expect, test } from "bun:test"
import { Schema } from "effect"
import { actorClient } from "./client"
import { legacyActorMethod } from "./method-compat"
import { targetMethods } from "./target"

const declaration = legacyActorMethod({
  input: Schema.String, output: Schema.String,
  event: () => ({ type: "Requested" }), state: () => ({ status: "pending" })
})
const coordinate = { actor: "test", instance: "rick", thread: "main" }

test("callable methods enumerate and invoke reserved names without shadowing metadata", async () => {
  // oxlint-disable-next-line unicorn/no-thenable -- This declaration tests that a method named then cannot make the reference thenable.
  const methods = { message: declaration, coordinate: declaration, address: declaration, methods: declaration, then: declaration, ["__proto__"]: declaration }
  const invoked: string[] = []
  const client = actorClient({ name: "test", methods }, {
    allocate: async (request) => request.kind === "root" ? coordinate : { ...coordinate, thread: request.child },
    invoke: async (target, name, input) => {
      expect(target).toEqual(coordinate)
      invoked.push(name)
      return input
    }
  })
  const ref = await client.allocateRootThread({ instance: "rick", name: "main" })
  expect(Object.keys(ref.methods)).toEqual(Object.keys(methods))
  expect(ref.coordinate).toEqual(coordinate)
  expect(ref.address).toBe(ref.coordinate)
  expect(await Promise.resolve(ref)).toBe(ref)
  expect(Object.hasOwn(ref, "then")).toBe(false)
  expect(ref.message).toBe(ref.methods.message)
  expect(targetMethods(ref)).toBe(methods)
  for (const name of Object.keys(methods) as Array<keyof typeof methods>) {
    expect(await ref.methods[name](name, { key: name })).toBe(name)
  }
  expect(invoked).toEqual(Object.keys(methods))
  await expect(ref.methods.message(123 as unknown as string, { key: "invalid" })).rejects.toThrow()
  expect(invoked).toEqual(Object.keys(methods))
  const child = await client.allocateChildThread({ parent: ref, name: "researcher" })
  expect(child.coordinate).toEqual({ ...coordinate, thread: "researcher" })
})
