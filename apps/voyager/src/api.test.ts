import { describe, expect, test } from "bun:test"

import { apiDocumentOf, apiGroupsOf, matchesOperation, resolvedSchema, schemaTypeOf } from "./api"

const raw = {
  info: { title: "Tardigrade", version: "1" },
  paths: {
    "/v1/actors": {
      get: {
        tags: ["actors"],
        operationId: "actors.list",
        parameters: [],
        responses: { 200: { description: "Success", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Actor" } } } } } }
      }
    }
  },
  components: { schemas: { Actor: { type: "object", properties: { name: { type: "string" } } } } }
}

describe("apiDocumentOf", () => {
  test("projects paths into stable operations", () => {
    const document = apiDocumentOf(raw)
    expect(document.title).toBe("Tardigrade")
    expect(document.operations[0]).toMatchObject({ key: "get:/v1/actors", method: "get", tag: "actors" })
    expect(document.operations[0]?.responses[0]?.content[0]?.mediaType).toBe("application/json")
  })

  test("groups and searches operations", () => {
    const operations = apiDocumentOf(raw).operations
    expect(apiGroupsOf(operations)[0]?.[0]).toBe("actors")
    expect(matchesOperation(operations[0]!, "LIST")).toBeTrue()
    expect(matchesOperation(operations[0]!, "threads")).toBeFalse()
  })

  test("resolves component names and array labels", () => {
    const document = apiDocumentOf(raw)
    const reference = { $ref: "#/components/schemas/Actor" }
    expect(resolvedSchema(reference, document.schemas).type).toBe("object")
    expect(schemaTypeOf({ type: "array", items: reference })).toBe("Actor[]")
  })
})
