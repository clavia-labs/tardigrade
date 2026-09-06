import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { directoryWithPlacement, mappedDirectory, type Directory, type Placement } from "./directory"

describe("directoryWithPlacement", () => {
  test("returns an existing destination without invoking placement", async () => {
    let placements = 0
    const directory = mappedDirectory((identity: string) => identity === "active" ? { node: "node-1" } : undefined)
    const placement: Placement<string, { readonly node: string }> = {
      place: () => Effect.sync(() => {
        placements += 1
        return { node: "node-2" }
      })
    }

    expect(await Effect.runPromise(directoryWithPlacement(directory, placement).resolve("active"))).toEqual({ node: "node-1" })
    expect(placements).toBe(0)
  })

  test("applies the stated placement when no destination exists", async () => {
    const directory: Directory<string, { readonly node: string }> = {
      resolve: () => Effect.as(Effect.void, undefined)
    }
    const placed: string[] = []
    const placement: Placement<string, { readonly node: string }> = {
      place: (identity) => Effect.sync(() => {
        placed.push(identity)
        return { node: "node-2" }
      })
    }

    expect(await Effect.runPromise(directoryWithPlacement(directory, placement).resolve("new"))).toEqual({ node: "node-2" })
    expect(placed).toEqual(["new"])
  })
})
