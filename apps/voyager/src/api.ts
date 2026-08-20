const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options", "head"] as const

type HttpMethod = typeof HTTP_METHODS[number]

export interface ApiSchema {
  readonly $ref?: string
  readonly type?: string
  readonly description?: string
  readonly enum?: ReadonlyArray<unknown>
  readonly anyOf?: ReadonlyArray<ApiSchema>
  readonly allOf?: ReadonlyArray<ApiSchema>
  readonly items?: ApiSchema
  readonly properties?: Readonly<Record<string, ApiSchema>>
  readonly required?: ReadonlyArray<string>
}

interface ApiParameter {
  readonly name: string
  readonly in: string
  readonly required: boolean
  readonly description: string | undefined
  readonly schema: ApiSchema | undefined
}

export interface ApiContent {
  readonly mediaType: string
  readonly schema: ApiSchema | undefined
}

interface ApiResponse {
  readonly status: string
  readonly description: string
  readonly content: ReadonlyArray<ApiContent>
}

export interface ApiOperation {
  readonly key: string
  readonly method: HttpMethod
  readonly path: string
  readonly tag: string
  readonly operationId: string | undefined
  readonly summary: string | undefined
  readonly description: string | undefined
  readonly parameters: ReadonlyArray<ApiParameter>
  readonly request: ReadonlyArray<ApiContent>
  readonly responses: ReadonlyArray<ApiResponse>
}

export interface ApiDocument {
  readonly title: string
  readonly version: string | undefined
  readonly description: string | undefined
  readonly operations: ReadonlyArray<ApiOperation>
  readonly schemas: Readonly<Record<string, ApiSchema>>
}

type UnknownRecord = Readonly<Record<string, unknown>>

const recordOf = (value: unknown): UnknownRecord | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as UnknownRecord : undefined

const stringOf = (value: unknown): string | undefined => typeof value === "string" ? value : undefined

const schemaOf = (value: unknown): ApiSchema | undefined => recordOf(value) as ApiSchema | undefined

const contentOf = (value: unknown): ReadonlyArray<ApiContent> =>
  Object.entries(recordOf(value) ?? {}).map(([mediaType, media]) => ({
    mediaType,
    schema: schemaOf(recordOf(media)?.schema)
  }))

const parametersOf = (value: unknown): ReadonlyArray<ApiParameter> =>
  Array.isArray(value)
    ? value.flatMap((item) => {
      const parameter = recordOf(item)
      const name = stringOf(parameter?.name)
      const location = stringOf(parameter?.in)
      return name === undefined || location === undefined
        ? []
        : [{
          name,
          in: location,
          required: parameter?.required === true,
          description: stringOf(parameter?.description),
          schema: schemaOf(parameter?.schema)
        }]
    })
    : []

const responsesOf = (value: unknown): ReadonlyArray<ApiResponse> =>
  Object.entries(recordOf(value) ?? {}).map(([status, raw]) => {
    const response = recordOf(raw)
    return {
      status,
      description: stringOf(response?.description) ?? "Response",
      content: contentOf(response?.content)
    }
  })

const operationKey = (method: HttpMethod, path: string): string => `${method}:${path}`

export const apiDocumentOf = (value: unknown): ApiDocument => {
  const document = recordOf(value) ?? {}
  const info = recordOf(document.info) ?? {}
  const operations: Array<ApiOperation> = []
  for (const [path, rawPath] of Object.entries(recordOf(document.paths) ?? {})) {
    const pathItem = recordOf(rawPath) ?? {}
    for (const method of HTTP_METHODS) {
      const operation = recordOf(pathItem[method])
      if (operation === undefined) continue
      const tags = Array.isArray(operation.tags) ? operation.tags : []
      const requestBody = recordOf(operation.requestBody)
      operations.push({
        key: operationKey(method, path),
        method,
        path,
        tag: stringOf(tags[0]) ?? "other",
        operationId: stringOf(operation.operationId),
        summary: stringOf(operation.summary),
        description: stringOf(operation.description),
        parameters: parametersOf(operation.parameters),
        request: contentOf(requestBody?.content),
        responses: responsesOf(operation.responses)
      })
    }
  }
  const schemas = recordOf(recordOf(document.components)?.schemas) ?? {}
  return {
    title: stringOf(info.title) ?? "API",
    version: stringOf(info.version),
    description: stringOf(info.description),
    operations,
    schemas: schemas as Readonly<Record<string, ApiSchema>>
  }
}

export const apiGroupsOf = (operations: ReadonlyArray<ApiOperation>): ReadonlyArray<readonly [string, ReadonlyArray<ApiOperation>]> => {
  const groups = new Map<string, Array<ApiOperation>>()
  for (const operation of operations) {
    const held = groups.get(operation.tag) ?? []
    held.push(operation)
    groups.set(operation.tag, held)
  }
  return [...groups.entries()]
}

export const matchesOperation = (operation: ApiOperation, query: string): boolean => {
  const needle = query.trim().toLocaleLowerCase()
  if (needle.length === 0) return true
  return [operation.method, operation.path, operation.tag, operation.operationId, operation.summary]
    .some((value) => value?.toLocaleLowerCase().includes(needle) === true)
}

const refNameOf = (schema: ApiSchema): string | undefined => schema.$ref?.split("/").at(-1)

export const resolvedSchema = (schema: ApiSchema, schemas: Readonly<Record<string, ApiSchema>>): ApiSchema => {
  const name = refNameOf(schema)
  return name === undefined ? schema : schemas[name] ?? schema
}

export const schemaTypeOf = (schema: ApiSchema): string => {
  const name = refNameOf(schema)
  if (name !== undefined) return name
  if (schema.enum !== undefined) return schema.enum.map(String).join(" | ")
  if (schema.anyOf !== undefined) return schema.anyOf.map(schemaTypeOf).join(" | ")
  if (schema.type === "array" && schema.items !== undefined) return `${schemaTypeOf(schema.items)}[]`
  return schema.type ?? "unknown"
}

export const schemaExampleOf = (
  schema: ApiSchema,
  schemas: Readonly<Record<string, ApiSchema>>,
  depth: number
): unknown => {
  const resolved = resolvedSchema(schema, schemas)
  if (resolved.enum !== undefined) return resolved.enum[0]
  if (resolved.anyOf !== undefined && resolved.anyOf[0] !== undefined) return schemaExampleOf(resolved.anyOf[0], schemas, depth)
  if (resolved.allOf !== undefined) {
    return Object.assign({}, ...resolved.allOf.map((part) => schemaExampleOf(part, schemas, depth)))
  }
  if (depth <= 0) return resolved.type === "array" ? [] : resolved.type === "object" ? {} : null
  if (resolved.type === "array") {
    return resolved.items === undefined ? [] : [schemaExampleOf(resolved.items, schemas, depth - 1)]
  }
  if (resolved.type === "object" || resolved.properties !== undefined) {
    return Object.fromEntries(
      Object.entries(resolved.properties ?? {}).map(([name, property]) => [name, schemaExampleOf(property, schemas, depth - 1)])
    )
  }
  if (resolved.type === "integer" || resolved.type === "number") return 0
  if (resolved.type === "boolean") return true
  return "string"
}
