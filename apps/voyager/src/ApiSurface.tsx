import { DOCS_PATH, OPENAPI_PATH } from "@clavia/tardigrade-client/contract"
import { ArrowLeft, ArrowSquareOut, MagnifyingGlass } from "@phosphor-icons/react"
import { useEffect, useMemo, useState, type ReactElement } from "react"

import {
  apiDocumentOf,
  apiGroupsOf,
  matchesOperation,
  resolvedSchema,
  schemaExampleOf,
  schemaTypeOf,
  type ApiContent,
  type ApiDocument,
  type ApiOperation,
  type ApiSchema
} from "./api"
import { client } from "./client"
import { navigate, useRoute } from "./nav"
import { API_SCHEMA_DEPTH, ICON_SIZE } from "./policy"
import { ThemeToggle } from "./ThemeToggle"

const useApiDocument = () => {
  const [document, setDocument] = useState<ApiDocument | undefined>(undefined)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  useEffect(() => {
    const abort = new AbortController()
    void fetch(`${client.baseUrl}${OPENAPI_PATH}`, { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`API description returned ${response.status}`)
        return response.json()
      })
      .then((value: unknown) => {
        setDocument(apiDocumentOf(value))
        setProblem(undefined)
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return
        setProblem(error instanceof Error ? error.message : String(error))
      })
    return () => abort.abort()
  }, [])
  return { document, problem }
}

const SchemaView = ({
  depth,
  schema,
  schemas
}: {
  readonly depth: number
  readonly schema: ApiSchema
  readonly schemas: Readonly<Record<string, ApiSchema>>
}): ReactElement => {
  const resolved = resolvedSchema(schema, schemas)
  const shaped = resolved.type === "array" && resolved.items !== undefined
    ? resolvedSchema(resolved.items, schemas)
    : resolved
  const properties = Object.entries(shaped.properties ?? {})
  const required = new Set(shaped.required ?? [])
  return (
    <div className="api-schema">
      <span className="mono api-type">{schemaTypeOf(schema)}</span>
      {properties.length === 0 ? null : depth <= 0 ? (
        <div className="mono api-schema-cut">nested fields hidden at depth 0</div>
      ) : (
        <div className="api-properties">
          {properties.map(([name, property]) => {
            const nested = resolvedSchema(property, schemas)
            const hasNested = nested.properties !== undefined || nested.items !== undefined
            return (
              <div className="api-property" key={name}>
                <div className="api-property-line">
                  <span className="mono api-property-name">{name}</span>
                  <span className="mono api-property-type">{schemaTypeOf(property)}</span>
                  {required.has(name) ? <span className="api-required">required</span> : <span className="api-optional">optional</span>}
                </div>
                {property.description === undefined ? null : <p>{property.description}</p>}
                {!hasNested ? null : <SchemaView schema={property} schemas={schemas} depth={depth - 1} />}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const Content = ({
  content,
  depth,
  schemas
}: {
  readonly content: ReadonlyArray<ApiContent>
  readonly depth: number
  readonly schemas: Readonly<Record<string, ApiSchema>>
}): ReactElement => (
  <div className="api-content-list">
    {content.map((entry) => (
      <div className="api-content" key={entry.mediaType}>
        <div className="mono api-media-type">{entry.mediaType}</div>
        {entry.schema === undefined ? null : <SchemaView schema={entry.schema} schemas={schemas} depth={depth} />}
      </div>
    ))}
  </div>
)

const OperationDetail = ({
  depth,
  document,
  operation,
  operations
}: {
  readonly depth: number
  readonly document: ApiDocument
  readonly operation: ApiOperation
  readonly operations: ReadonlyArray<ApiOperation>
}): ReactElement => {
  const requestContent = operation.request[0]
  const success = operation.responses.find((response) => response.status.startsWith("2")) ?? operation.responses[0]
  const responseContent = success?.content[0]
  const requestExample = requestContent?.schema === undefined ? undefined : schemaExampleOf(requestContent.schema, document.schemas, depth)
  const responseExample = responseContent?.schema === undefined ? undefined : schemaExampleOf(responseContent.schema, document.schemas, depth)
  const curl = [
    `curl ${client.baseUrl}${operation.path}`,
    ...(operation.method === "get" ? [] : [`  --request ${operation.method.toUpperCase()}`]),
    "  --header 'Accept: application/json'",
    ...(requestExample === undefined ? [] : [
      `  --header 'Content-Type: ${requestContent?.mediaType ?? "application/json"}'`,
      `  --data '${JSON.stringify(requestExample, null, 2)}'`
    ])
  ].join(" \\\n")
  return (
    <article className="api-detail api-operation-detail">
      <section className="api-tag-overview">
        <div>
          <div className="mono api-eyebrow">Resource</div>
          <h1>{operation.tag}</h1>
        </div>
        <div className="api-operations-card">
          <div className="api-card-title">Operations</div>
          <div className="api-operations-list">
            {operations.map((candidate) => (
              <button type="button" key={candidate.key} onClick={() => navigate({ operation: candidate.key })}>
                <span className={`mono api-method api-method-${candidate.method}`}>{candidate.method.toUpperCase()}</span>
                <span className="mono">{candidate.path}</span>
              </button>
            ))}
          </div>
        </div>
      </section>
      <header className="api-detail-head">
        <h2 className="mono">{operation.path}</h2>
        {operation.operationId === undefined ? null : <div className="mono api-operation-id">{operation.operationId}</div>}
        {operation.summary === undefined ? null : <p>{operation.summary}</p>}
        {operation.description === undefined ? null : <p>{operation.description}</p>}
      </header>
      <div className="api-operation-grid">
        <div className="api-operation-docs">
          {operation.parameters.length === 0 ? null : (
            <section className="api-section">
              <h3>Parameters</h3>
              <div className="api-parameters">
                {operation.parameters.map((parameter) => (
                  <div className="api-parameter" key={`${parameter.in}:${parameter.name}`}>
                    <div>
                      <span className="mono api-property-name">{parameter.name}</span>
                      <span className="mono api-parameter-in">{parameter.in}</span>
                    </div>
                    <div className="mono api-property-type">
                      {parameter.schema === undefined ? "unknown" : schemaTypeOf(parameter.schema)}
                    </div>
                    <span className={parameter.required ? "api-required" : "api-optional"}>{parameter.required ? "required" : "optional"}</span>
                    {parameter.description === undefined ? null : <p>{parameter.description}</p>}
                  </div>
                ))}
              </div>
            </section>
          )}
          {operation.request.length === 0 ? null : (
            <section className="api-section">
              <h3>Request body</h3>
              <Content content={operation.request} schemas={document.schemas} depth={depth} />
            </section>
          )}
          <section className="api-section">
            <h3>Responses</h3>
            <div className="api-responses">
              {operation.responses.map((response) => (
                <div className="api-response" key={response.status}>
                  <div className="api-response-head">
                    <span className={`mono api-status${response.status.startsWith("2") ? " api-status-ok" : ""}`}>{response.status}</span>
                    <span>{response.description}</span>
                  </div>
                  {response.content.length === 0 ? null : <Content content={response.content} schemas={document.schemas} depth={depth} />}
                </div>
              ))}
            </div>
          </section>
        </div>
        <aside className="api-operation-examples">
          <section className="api-code-card">
            <div className="api-code-head">
              <div><span className={`mono api-method api-method-${operation.method}`}>{operation.method.toUpperCase()}</span><span className="mono">{operation.path}</span></div>
              <span className="mono">Shell Curl</span>
            </div>
            <pre><code>{curl}</code></pre>
          </section>
          {responseExample === undefined ? null : (
            <section className="api-code-card">
              <div className="api-code-head">
                <div><span className="mono api-status api-status-ok">{success?.status}</span><span>{success?.description}</span></div>
                <span className="mono">{responseContent?.mediaType}</span>
              </div>
              <pre><code>{JSON.stringify(responseExample, null, 2)}</code></pre>
            </section>
          )}
        </aside>
      </div>
    </article>
  )
}

const Overview = ({ document }: { readonly document: ApiDocument }): ReactElement => (
  <article className="api-detail api-overview">
    <div className="mono api-eyebrow">API reference</div>
    <h1>{document.title}</h1>
    {document.version === undefined ? null : <span className="mono api-version">v{document.version}</span>}
    {document.description === undefined ? null : <p>{document.description}</p>}
    <dl className="api-facts">
      <div><dt>Base URL</dt><dd className="mono">{client.baseUrl}</dd></div>
      <div><dt>Operations</dt><dd className="mono">{document.operations.length}</dd></div>
      <div><dt>Specification</dt><dd className="mono">OpenAPI 3.1</dd></div>
    </dl>
  </article>
)

export const ApiSurface = ({ schemaDepth = API_SCHEMA_DEPTH }: { readonly schemaDepth?: number | undefined }): ReactElement => {
  const route = useRoute()
  const { document, problem } = useApiDocument()
  const [query, setQuery] = useState("")
  const shown = useMemo(
    () => document?.operations.filter((operation) => matchesOperation(operation, query)) ?? [],
    [document, query]
  )
  const selected = document?.operations.find((operation) => operation.key === route.operation)
  return (
    <div className="api-view">
      <aside className="api-nav">
        <div className="api-nav-head">
          <button
            type="button"
            className="icon-btn"
            aria-label="Back to Voyager"
            title="Back to Voyager"
            onClick={() => navigate({ view: undefined, operation: undefined }, { replace: true })}
          >
            <ArrowLeft size={ICON_SIZE} weight="light" aria-hidden="true" />
          </button>
          <div>
            <div className="rail-wordmark">voyager</div>
            <div className="mono actor-label">api</div>
          </div>
        </div>
        <label className="api-search-wrap">
          <MagnifyingGlass size={ICON_SIZE} weight="light" aria-hidden="true" />
          <input
            value={query}
            placeholder="search endpoints…"
            aria-label="search API endpoints"
            onChange={(changed) => setQuery(changed.target.value)}
          />
        </label>
        <nav className="api-nav-list" aria-label="API endpoints">
          <button
            type="button"
            className={`api-overview-link${route.operation === undefined ? " api-nav-selected" : ""}`}
            onClick={() => navigate({ operation: undefined })}
          >
            Overview
          </button>
          {apiGroupsOf(shown).map(([tag, operations]) => (
            <section className="api-group" key={tag}>
              <h2 className="mono">{tag}</h2>
              {operations.map((operation) => (
                <button
                  type="button"
                  key={operation.key}
                  className={`api-nav-row${selected?.key === operation.key ? " api-nav-selected" : ""}`}
                  onClick={() => navigate({ operation: operation.key })}
                >
                  <span className={`mono api-method api-method-${operation.method}`}>{operation.method.toUpperCase()}</span>
                  <span className="mono api-nav-path">{operation.path}</span>
                </button>
              ))}
            </section>
          ))}
        </nav>
        <a className="api-full-reference" href={`${client.baseUrl}${DOCS_PATH}`} target="_blank" rel="noreferrer">
          Interactive reference
          <ArrowSquareOut size={ICON_SIZE} weight="light" aria-hidden="true" />
        </a>
      </aside>
      <main className="api-reading">
        {problem !== undefined ? (
          <div className="problem api-load-problem"><div className="problem-title">API description unavailable</div><div className="problem-detail">{problem}</div></div>
        ) : document === undefined ? (
          <div className="mono pane-empty">loading API description</div>
        ) : selected === undefined ? (
          <Overview document={document} />
        ) : (
          <OperationDetail
            operation={selected}
            operations={document.operations.filter((operation) => operation.tag === selected.tag)}
            document={document}
            depth={schemaDepth}
          />
        )}
      </main>
      <ThemeToggle />
    </div>
  )
}
