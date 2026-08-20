import { HttpServerResponse } from "effect/unstable/http"

export const PROBLEM_CONTENT_TYPE = "application/problem+json"

// The base of the `type` URI in a problem document. RFC 9457 wants a URI that identifies the error
// kind; a client matches on it rather than on the human title.
export const PROBLEM_TYPE_BASE = "https://tardigrade.dev/problems/"

export interface Problem {
  readonly type: string
  readonly title: string
  readonly status: number
  readonly detail?: string
}

// problem renders an error as application/problem+json (apps-server-spec.md, "Conventions"). Every
// failing route answers in this one shape, so a client parses errors once.
export const problem = (options: {
  readonly status: number
  readonly title: string
  readonly kind: string
  readonly detail?: string | undefined
}): HttpServerResponse.HttpServerResponse => {
  const body: Problem = {
    type: `${PROBLEM_TYPE_BASE}${options.kind}`,
    title: options.title,
    status: options.status,
    ...(options.detail === undefined ? {} : { detail: options.detail })
  }
  return HttpServerResponse.jsonUnsafe(body, {
    status: options.status,
    contentType: PROBLEM_CONTENT_TYPE
  })
}
