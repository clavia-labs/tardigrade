import { expect, test } from "bun:test"
import type { Action } from "tardie/log/events"
import {
  actor,
  agentMethods,
  budget,
  budgetAuthority,
  caller,
  codeMode,
  compaction,
  infer,
  NATIVE_MODE,
  nativeOutput,
  output,
  validateActor
} from "tardie"
import { agentsPackage } from "tardie/packages/agents"
import { workspacePackage } from "@clavia/tardigrade-code/package/workspace"
import { actorScenario, ROOT_LANE, TEST_MODEL, type Mind } from "./harness"

const WORKER_RESULT = output({
  name: "worker-result",
  schema: {
    type: "object",
    properties: {
      worker: { type: "integer" },
      status: { type: "string", enum: ["granted", "denied"] }
    },
    required: ["worker", "status"],
    additionalProperties: false
  }
})

const work = () => codeMode([
  agentsPackage({ budget: {}, outputs: { worker: WORKER_RESULT } }),
  workspacePackage({ policy: {} })
])

test("an actor graph covers concurrent calls, budget negotiation, structured output, background work, and terminal aggregation", async () => {
  const action = ({ kind, ...fields }: Action): Action => ({
    kind,
    ...fields,
    mode: NATIVE_MODE
  } as Action)
  const mind: Mind = async ({ trajectory }) => {
    const head = [...trajectory].reverse().find((event) => event.type === "MessageReceived") as {
      readonly id?: unknown
      readonly text?: unknown
    } | undefined
    const turn = String(head?.id ?? "")
    const brief = String(head?.text ?? "")
    const slice = trajectory.filter((event) =>
      event === head || String((event as { readonly turn?: unknown }).turn ?? "") === turn
    )
    if (brief === "cover the actor graph") {
      const returned = slice.find((event) => event.type === "ToolReturned") as {
        readonly result?: { readonly result?: unknown }
      } | undefined
      if (returned !== undefined) {
        return { kind: "complete", output: JSON.stringify(returned.result?.result) }
      }
      return {
        kind: "call",
        callId: "cover",
        name: "execute",
        arguments: {
          code: `const foreground = await Promise.all(Array.from({ length: 5 }, (_, worker) =>
            agents.run({ text: "worker " + worker, budget: 1, escalatable: true, output: "worker" })
          ));
          const background = await agents.run({ text: "background", background: true });
          const later = await agents.result({ id: background.callId });
          return { foreground: foreground.map((answer) => answer.output), background: later.output };`
        }
      }
    }
    if (brief === "background") return { kind: "complete", output: "background-ok" }
    const worker = Number(brief.slice("worker ".length))
    const called = (id: string): boolean => slice.some((event) =>
      event.type === "ToolCalled" && String((event as { readonly callId?: unknown }).callId) === id
    )
    const returned = (id: string): boolean => slice.some((event) =>
      event.type === "ToolReturned" && String((event as { readonly callId?: unknown }).callId) === id
    )
    if (!called(`${turn}-first`)) {
      return action({ kind: "call", callId: `${turn}-first`, name: "execute", arguments: { code: `return "first-${worker}";` } })
    }
    if (!called(`${turn}-wall`)) {
      return action({ kind: "call", callId: `${turn}-wall`, name: "execute", arguments: { code: `return "wall-${worker}";` } })
    }
    if (!called(`${turn}-budget`)) {
      return action({
        kind: "call",
        callId: `${turn}-budget`,
        name: "request_budget",
        arguments: { reason: `worker ${worker} needs one verified follow-up`, amount: 2 }
      })
    }
    if (slice.some((event) => event.type === "BudgetDenied")) {
      return action({ kind: "complete", output: JSON.stringify({ worker, status: "denied" }) })
    }
    if (!called(`${turn}-after`)) {
      return action({ kind: "call", callId: `${turn}-after`, name: "execute", arguments: { code: `return "after-${worker}";` } })
    }
    if (returned(`${turn}-after`)) {
      return action({ kind: "complete", output: JSON.stringify({ worker, status: "granted" }) })
    }
    return action({ kind: "fail", error: `worker ${worker} reached an impossible state` })
  }
  const assembled = validateActor(actor({
    name: "coverage-agent",
    methods: agentMethods,
    components: [
      infer([budget([work()], {
        authority: caller()
      }), compaction(), nativeOutput], TEST_MODEL),
      budgetAuthority({
        decide: (request) => {
          if (request.reason.startsWith("worker 4 ")) throw new Error("the authority is unavailable")
          return request.reason.startsWith("worker 3 ")
            ? request.deny("the final source is optional")
            : request.grant()
        }
      })
    ]
  }))
  const graph = actorScenario(assembled, mind)
  expect(assembled.contract.methods.map((method) => [method.name, method.handling])).toEqual([
    ["message", ["local"]],
    ["requestBudget", ["local"]]
  ])
  expect(assembled.contract.calls.map((call) => [call.methodName, "kind" in call.target ? call.target.kind : "fixed"])).toEqual([
    ["requestBudget", "caller"]
  ])
  const answer = await graph.run("cover the actor graph")
  expect(JSON.parse(answer.output ?? "null")).toEqual({
    foreground: [
      { worker: 0, status: "granted" },
      { worker: 1, status: "granted" },
      { worker: 2, status: "granted" },
      { worker: 3, status: "denied" },
      { worker: 4, status: "denied" }
    ],
    background: "background-ok"
  })

  const root = graph.host.read(ROOT_LANE)
  const runs = root.filter((event) =>
    event.type === "PackageCalled" && String((event as { readonly name?: unknown }).name) === "agents.run"
  ) as ReadonlyArray<{ readonly callId?: unknown }>
  expect(runs).toHaveLength(6)
  expect(root.filter((event) => event.type === "BudgetRequestReceived")).toHaveLength(5)
  expect(root.filter((event) => event.type === "BudgetRequestDecided")).toHaveLength(4)
  expect(root.filter((event) => event.type === "BudgetRequestFailed")).toHaveLength(1)
  expect(root.filter((event) =>
    event.type === "ResponseDelivered" &&
    String((event as { readonly method?: unknown }).method) === "requestBudget"
  )).toHaveLength(5)
  expect(root.filter((event) =>
    event.type === "ResponseReceived" &&
    String((event as { readonly method?: unknown }).method) === "message"
  )).toHaveLength(6)

  for (const run of runs.slice(0, 5)) {
    const child = graph.host.read(`ag.${String(run.callId)}`)
    expect(child.filter((event) => event.type === "BudgetExhausted")).toHaveLength(1)
    expect(child.filter((event) => event.type === "BudgetRequested")).toHaveLength(1)
    expect(child.filter((event) => event.type === "CallDispatched")).toHaveLength(1)
    expect(child.filter((event) =>
      event.type === "ResponseReceived" &&
      String((event as { readonly method?: unknown }).method) === "requestBudget"
    )).toHaveLength(1)
    expect(child.filter((event) =>
      event.type === "ResponseDelivered" &&
      String((event as { readonly method?: unknown }).method) === "message"
    )).toHaveLength(1)
    expect(child.filter((event) => event.type === "TurnCompleted")).toHaveLength(1)
  }
  expect(graph.host.resting()).toBe(true)
})
