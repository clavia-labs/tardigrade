import type { Problem } from "./contract"

// What a failed call throws, and how a response becomes one. The server answers every failure as an
// RFC 9457 problem document (apps/server/src/problem.ts), so a caller that renders these four
// fields renders the server's own words rather than prose this package invented.

// ProblemError is what a failed call throws. `type`, `title`, `status`, and `detail` are the
// document's own fields and a screen shows them verbatim (problem.test.ts, "a problem document
// surfaces all four fields"). A failure that carries no document lands here too, so a caller
// handles one error shape: `type` is then absent, and `status` is 0 when no answer arrived at all.
export class ProblemError extends Error {
  readonly type: string | undefined
  readonly title: string
  readonly status: number
  readonly detail: string | undefined

  constructor(problem: {
    readonly type?: string | undefined
    readonly title: string
    readonly status: number
    readonly detail?: string | undefined
  }) {
    super(problem.detail === undefined ? problem.title : `${problem.title}: ${problem.detail}`)
    this.name = "ProblemError"
    this.type = problem.type
    this.title = problem.title
    this.status = problem.status
    this.detail = problem.detail
  }
}

// The status a ProblemError carries when the failure never reached a response: a transport refusal,
// a request this client would not encode, a frame it could not read.
export const NO_ANSWER = 0

// isProblem tells a decoded problem document from anything else. The three fields it matches on are
// the three RFC 9457 requires and the declaration states as literals (contract.ts, problemKind), so
// a document from this server always passes and a stray object does not.
export const isProblem = (value: unknown): value is Problem =>
  typeof value === "object" && value !== null &&
  typeof (value as Problem).type === "string" &&
  typeof (value as Problem).title === "string" &&
  typeof (value as Problem).status === "number"

// problemOf reads a failed response's body as RFC 9457. A body that is not one, or is not JSON at
// all, yields `fallback` as the title and the response's own status: this package invents no error
// prose either way (problem.test.ts, "a body that is not a problem document falls back").
export const problemOf = (status: number, body: unknown, fallback: string): ProblemError => {
  if (isProblem(body)) {
    return new ProblemError({
      type: body.type,
      title: body.title,
      status: body.status,
      ...(typeof body.detail === "string" && body.detail.length > 0 ? { detail: body.detail } : {})
    })
  }
  return new ProblemError({ title: fallback, status })
}
