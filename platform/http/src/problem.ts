import { HttpServerResponse } from "effect/unstable/http"
import { PROBLEM_CONTENT_TYPE, PROBLEM_TYPE_BASE, type Problem } from "@clavia/tardigrade-client/contract"

// Rendering a problem document as a response. The document's own vocabulary is the declaration's
// (packages/client/src/contract.ts), because a client matches on the same `type` URI this server
// writes; what belongs here is only how the bytes leave.
export { PROBLEM_CONTENT_TYPE, PROBLEM_TYPE_BASE, type Problem }

// problemResponse renders a problem document as the response that carries it. A route that already
// holds the document uses this; a route that states one inline uses `problem` below.
export const problemResponse = (document: Problem): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(document, {
    status: document.status,
    contentType: PROBLEM_CONTENT_TYPE
  })

// problem renders an error as application/problem+json (apps-server-spec.md, "Conventions"). Every
// failing route answers in this one shape, so a client parses errors once.
export const problem = (options: {
  readonly status: number
  readonly title: string
  readonly kind: string
  readonly detail?: string | undefined
}): HttpServerResponse.HttpServerResponse =>
  problemResponse({
    type: `${PROBLEM_TYPE_BASE}${options.kind}`,
    title: options.title,
    status: options.status,
    ...(options.detail === undefined ? {} : { detail: options.detail })
  })
