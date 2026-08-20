import { Effect, Layer, type SchemaIssue } from "effect"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import {
  AgentNode,
  AgentStatus,
  AgentSummary,
  InvalidRequest,
  invalidRequest,
  missingField,
  RequestProblems,
  TurnStatus,
  TurnView,
  unacceptableField,
  UnknownAgent,
  type Problem
} from "@clavia/tardigrade-client/contract"

import type * as Projections from "./projections"

// This server's side of the contract. The declaration itself is a package
// (packages/client/src/contract.ts) because the client and the browser read it too; what stays here
// is what only a server can hold: the implementation of the declaration's request guarantee, and
// the proof that the projections the handlers return are the shapes the declaration promises.

// faultsOf names the fields a refusal names. A schema issue is a tree: pointers carry the path, a
// composite or a union carries the alternatives, and the leaves say whether a value was missing or
// unacceptable. Only the leaf names reach the wire, because the rest of the tree is this server's
// vocabulary and not the caller's.
const faultsOf = (issue: SchemaIssue.Issue, path: ReadonlyArray<PropertyKey> = []): ReadonlyArray<string> => {
  switch (issue._tag) {
    case "Pointer":
      return faultsOf(issue.issue, [...path, ...issue.path])
    case "Composite":
    case "AnyOf":
      return issue.issues.flatMap((nested) => faultsOf(nested, path))
    case "Filter":
    case "Encoding":
      return faultsOf(issue.issue, path)
    case "MissingKey":
      return path.length === 0 ? [] : [missingField(path.join("."))]
    default:
      return path.length === 0 ? [] : [unacceptableField(path.join("."))]
  }
}

// layerRequestProblems implements the guarantee. `Body` and `ResponseHeaders` are this server
// failing to encode its own answer, which is a defect and stays one: re-failing with the schema
// error is what the framework turns back into a 500 rather than blaming the caller.
export const layerRequestProblems: Layer.Layer<RequestProblems> = HttpApiMiddleware.layerSchemaErrorTransform(
  RequestProblems,
  (error) => {
    if (error.kind === "Body" || error.kind === "ResponseHeaders") return Effect.fail(error)
    const faults = [...new Set(faultsOf(error.cause.issue))]
    return Effect.fail(invalidRequest(error.kind, faults))
  }
)

// The declaration's Schemas are the one definition of the wire types. projections.ts keeps
// hand-written interfaces so the read side stays a pure function of a log with no Schema in its
// imports, and the two are held together here: each assertion accepts `true` only when the
// projection's type and the Schema's type are the same, so changing either alone fails the
// typecheck (tools/gate.ts, typecheck:app-server).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

type Extends<A, B> = [A] extends [B] ? true : never

const asserts = <_ extends true>(): void => {}

asserts<Same<Projections.AgentStatus, typeof AgentStatus.Type>>()
asserts<Same<Projections.AgentSummary, typeof AgentSummary.Type>>()
asserts<Same<Projections.AgentNode, typeof AgentNode.Type>>()
asserts<Same<Projections.TurnStatus, typeof TurnStatus.Type>>()
asserts<Same<Projections.TurnView, typeof TurnView.Type>>()
asserts<Extends<typeof UnknownAgent.schema.Type, Problem>>()
asserts<Extends<typeof InvalidRequest.schema.Type, Problem>>()
