import { expect, test } from "bun:test"
import fc from "fast-check"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { threadAddressOf } from "@clavia/tardigrade-core/communication/endpoint"
import { threadCreated } from "@clavia/tardigrade-core/thread"
import { alarmFired } from "@clavia/tardigrade-core/method"
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
  permissionAuthority,
  permissions,
  requestPermissionMethod,
  validateActor
} from "tardie"
import { agentsPackage } from "tardie/packages/agents"
import { workspacePackage } from "@clavia/tardigrade-code/package/workspace"
import { actorScenario, childThreadsOf, ROOT_THREAD, TEST_MODEL, type Mind } from "./harness"

type Outcome = "grant" | "deny" | "fail" | "timeout"

interface Mission {
  readonly key: string
  readonly background: boolean
  readonly firstPermission: Outcome
  readonly budget: Outcome
  readonly secondPermission: Outcome
}

type MissionSeed = Omit<Mission, "key">

interface Universe {
  readonly missions: ReadonlyArray<MissionSeed>
  readonly schedule: ReadonlyArray<number>
  readonly jitter: ReadonlyArray<number>
  readonly concurrency: number
}

const outcome = fc.constantFrom<Outcome>("grant", "deny", "fail", "timeout")
const randomMission = fc.record({
  background: fc.boolean(),
  firstPermission: outcome,
  budget: outcome,
  secondPermission: outcome
})
const requiredMission = (
  firstPermission: Outcome,
  budget: Outcome,
  secondPermission: Outcome
) => fc.record({
  background: fc.boolean(),
  firstPermission: fc.constant(firstPermission),
  budget: fc.constant(budget),
  secondPermission: fc.constant(secondPermission)
})

const universe = fc.record({
  required: fc.tuple(
    requiredMission("grant", "grant", "grant"),
    requiredMission("deny", "grant", "grant"),
    requiredMission("grant", "fail", "grant"),
    requiredMission("timeout", "grant", "grant"),
    requiredMission("grant", "grant", "timeout")
  ),
  extra: fc.array(randomMission, { minLength: 0, maxLength: 5 }),
  schedule: fc.array(fc.nat(), { minLength: 32, maxLength: 96 }),
  jitter: fc.array(fc.nat({ max: 3 }), { minLength: 8, maxLength: 32 }),
  concurrency: fc.integer({ min: 1, max: 8 })
}).map(({ required, extra, schedule, jitter, concurrency }): Universe => ({
  missions: [...required, ...extra],
  schedule,
  jitter,
  concurrency
}))

const action = ({ kind, ...fields }: Action): Action => ({
  kind,
  ...fields,
  mode: NATIVE_MODE
} as Action)

const field = (event: Event, name: string): unknown =>
  (event as Record<string, unknown>)[name]

const responseFor = (
  trajectory: ReadonlyArray<Event>,
  turn: string,
  toolCall: string
): { readonly type: string; readonly status?: unknown; readonly output?: unknown } | undefined =>
  trajectory.find((event) =>
    (event.type === "ResponseReceived" || event.type === "CallTimedOut") &&
    field(event, "method") === "requestPermission" &&
    field(event, "call") === `permission/${turn}/${toolCall}`
  ) as { readonly type: string; readonly status?: unknown; readonly output?: unknown } | undefined

const outcomeOf = (response: { readonly type: string; readonly status?: unknown; readonly output?: unknown }): Outcome => {
  if (response.type === "CallTimedOut") return "timeout"
  if (response.status === "failed") return "fail"
  return typeof response.output === "object" && response.output !== null && "denied" in response.output
    ? "deny"
    : "grant"
}

const expectedStatus = (mission: Mission): string => {
  if (mission.firstPermission !== "grant") return `permission-1-${mission.firstPermission}`
  if (mission.budget !== "grant") return `budget-${mission.budget}`
  if (mission.secondPermission !== "grant") return `permission-2-${mission.secondPermission}`
  return "escaped"
}

const portalCode = (key: string, round: number): string =>
  `return "portal-tool:${key}:${round}";`

const mindFor = (missions: ReadonlyMap<string, Mission>, jitter: ReadonlyArray<number>): Mind =>
  async ({ trajectory }, key) => {
    const delay = jitter[Math.abs([...String(key ?? "")].reduce((sum, char) => sum + char.charCodeAt(0), 0)) % jitter.length] ?? 0
    await new Promise<void>((resolve) => setTimeout(resolve, delay))

    const head = [...trajectory].reverse().find((event) => event.type === "MessageReceived") as {
      readonly id?: unknown
      readonly text?: unknown
    } | undefined
    const turn = String(head?.id ?? "")
    const brief = String(head?.text ?? "")
    const slice = trajectory.filter((event) =>
      event === head || String(field(event, "turn") ?? "") === turn
    )

    if (brief === "Rick opens every portal") {
      const returned = slice.find((event) => event.type === "ToolReturned") as {
        readonly result?: { readonly result?: unknown }
      } | undefined
      if (returned !== undefined) {
        return { kind: "complete", output: JSON.stringify(returned.result?.result) }
      }
      const manifest = JSON.stringify([...missions.values()].map((mission) => ({
        key: mission.key,
        background: mission.background
      })))
      return {
        kind: "call",
        callId: `${turn}-rick-plan`,
        name: "execute",
        arguments: {
          code: `const missions = ${manifest};
            const launched = await Promise.all(missions.map(async (mission) => {
              const answer = await agents.run({
                text: "Morty mission " + mission.key,
                budget: 1,
                escalatable: true,
                background: mission.background
              });
              return { mission, answer };
            }));
            return await Promise.all(launched.map(async ({ mission, answer }) => {
              const terminal = mission.background
                ? await agents.result({ handle: answer.handle })
                : answer;
              return JSON.parse(terminal.output);
            }));`
        }
      }
    }

    const missionKey = brief.slice("Morty mission ".length)
    const mission = missions.get(missionKey)
    if (mission === undefined) return { kind: "fail", error: `unknown dimension ${missionKey}` }
    const first = `${turn}-portal-1`
    const wall = `${turn}-wall`
    const second = `${turn}-portal-2`
    const budgetCall = `${turn}-budget`
    const called = (id: string): boolean => slice.some((event) =>
      event.type === "ToolCalled" && field(event, "callId") === id
    )
    const returned = (id: string): boolean => slice.some((event) =>
      event.type === "ToolReturned" && field(event, "callId") === id
    )

    if (!called(first)) {
      return action({ kind: "call", callId: first, name: "execute", arguments: { code: portalCode(mission.key, 1) } })
    }
    const firstResponse = responseFor(trajectory, turn, first)
    if (firstResponse !== undefined && outcomeOf(firstResponse) !== "grant") {
      return action({ kind: "complete", output: JSON.stringify({ key: mission.key, status: `permission-1-${outcomeOf(firstResponse)}` }) })
    }
    if (firstResponse === undefined || !returned(first)) {
      return action({ kind: "fail", error: `Morty ${mission.key} resumed before the first portal settled` })
    }
    if (!called(wall)) {
      return action({ kind: "call", callId: wall, name: "execute", arguments: { code: `return "budget-wall:${mission.key}";` } })
    }
    if (slice.some((event) => event.type === "BudgetDenied")) {
      return action({ kind: "complete", output: JSON.stringify({ key: mission.key, status: `budget-${mission.budget}` }) })
    }
    if (!slice.some((event) => event.type === "BudgetGranted")) {
      if (!called(budgetCall)) {
        return action({
          kind: "call",
          callId: budgetCall,
          name: "request_budget",
          arguments: { reason: `budget:${mission.key}`, amount: 2 }
        })
      }
      return action({ kind: "fail", error: `Morty ${mission.key} resumed before the budget authority answered` })
    }
    if (!called(second)) {
      return action({ kind: "call", callId: second, name: "execute", arguments: { code: portalCode(mission.key, 2) } })
    }
    const secondResponse = responseFor(trajectory, turn, second)
    if (secondResponse !== undefined && outcomeOf(secondResponse) !== "grant") {
      return action({ kind: "complete", output: JSON.stringify({ key: mission.key, status: `permission-2-${outcomeOf(secondResponse)}` }) })
    }
    if (secondResponse === undefined || !returned(second)) {
      return action({ kind: "fail", error: `Morty ${mission.key} resumed before the second portal settled` })
    }
    return action({ kind: "complete", output: JSON.stringify({ key: mission.key, status: "escaped" }) })
  }

test("Rick and Morty survive generated portal, budget, permission, human, and scheduling chaos", async () => {
  await fc.assert(fc.asyncProperty(universe, async (generated) => {
    const missions = generated.missions.map((mission, index): Mission => ({
      ...mission,
      key: `c137-${index}`
    }))
    const byKey = new Map(missions.map((mission) => [mission.key, mission]))
    const humanThread = "ag.president-morty"
    const human = {
      address: threadAddressOf("mem", "main", humanThread),
      methods: { requestPermission: requestPermissionMethod }
    }
    const assembled = validateActor(actor({
      name: "citadel",
      methods: { ...agentMethods, requestPermission: requestPermissionMethod },
      components: [
        infer([
          budget([
            permissions([
              codeMode([
                agentsPackage({ budget: {} }),
                workspacePackage({ policy: {} })
              ])
            ], {
              authority: human,
              request: (call) => {
                const code = typeof call.arguments === "object" && call.arguments !== null && "code" in call.arguments
                  ? String(call.arguments.code)
                  : ""
                const match = /portal-tool:([^:"]+):(\d+)/u.exec(code)
                if (match === null) return undefined
                const mission = byKey.get(match[1]!)
                const permission = match[2] === "1" ? mission?.firstPermission : mission?.secondPermission
                return {
                  action: "open-portal",
                  resource: `dimension/${match[1]}/${match[2]}`,
                  reason: `Morty ${match[1]} wants portal ${match[2]}`,
                  ...(permission === "timeout" ? { timeoutMs: 1 } : {})
                }
              }
            })
          ], { authority: caller() }),
          compaction(),
          nativeOutput
        ], TEST_MODEL),
        budgetAuthority({
          decide: (request) => {
            const mission = byKey.get(request.reason.slice("budget:".length))
            if (mission?.budget === "fail") throw new Error("the Citadel lost the paperwork")
            return mission?.budget === "grant"
              ? request.grant()
              : request.deny("Rick says one portal was enough")
          }
        }),
        permissionAuthority.manual()
      ]
    }))
    let pickIndex = 0
    const scenario = actorScenario(assembled, mindFor(byKey, generated.jitter), {
      driver: { maxConcurrentThreads: generated.concurrency },
      pick: (dirty) => {
        const threads = [...dirty].sort()
        const choice = generated.schedule[pickIndex++ % generated.schedule.length] ?? 0
        return threads[choice % threads.length]!
      }
    })
    scenario.host.seed(humanThread, [threadCreated(threadAddressOf("mem", "main", humanThread), undefined, 0)])
    const turn = scenario.enqueue("Rick opens every portal")
    await scenario.drive()
    expect(scenario.host.resting()).toBe(true)

    let decisionAt = 1
    let decisionIndex = 0
    for (let round = 0; round < 32 && scenario.result(turn).output === undefined; round++) {
      const current = scenario.result(turn)
      if (current.error !== "the root did not reach a terminal boundary") {
        throw new Error(`Rick failed before the human answered: ${String(current.error)}`)
      }
      const humanLog = scenario.host.read(humanThread)
      const terminals = new Set(humanLog
        .filter((event) => event.type === "PermissionRequestDecided" || event.type === "PermissionRequestFailed")
        .map((event) => String(field(event, "callId"))))
      const pendingDecisions = humanLog.filter((event) =>
        event.type === "PermissionRequestReceived" && !terminals.has(String(field(event, "id")))
      ).filter((request) => {
        const match = /^dimension\/([^/]+)\/(\d+)$/u.exec(String(field(request, "resource")))
        const mission = byKey.get(match?.[1] ?? "")
        return (match?.[2] === "1" ? mission?.firstPermission : mission?.secondPermission) !== "timeout"
      })
      const children = childThreadsOf(scenario.host.read(ROOT_THREAD))
      const timeoutCalls = scenario.host.read(ROOT_THREAD)
        .filter((event) => event.type === "PackageCalled" && field(event, "name") === "agents.run")
        .flatMap((run) => {
          const thread = children.get(String(field(run, "callId")))!
          const child = scenario.host.read(thread)
          const terminal = new Set(child
            .filter((event) => event.type === "ResponseReceived" || event.type === "CallTimedOut")
            .map((event) => String(field(event, "call"))))
          return child.flatMap((event) => {
            if (event.type !== "CallDispatched" || field(event, "method") !== "requestPermission") return []
            const input = field(event, "input")
            const resource = typeof input === "object" && input !== null && "resource" in input
              ? String(input.resource)
              : ""
            const match = /^dimension\/([^/]+)\/(\d+)$/u.exec(resource)
            const mission = byKey.get(match?.[1] ?? "")
            const permission = match?.[2] === "1" ? mission?.firstPermission : mission?.secondPermission
            const call = String(field(event, "id"))
            return permission === "timeout" && !terminal.has(call) ? [{ thread, dispatch: event }] : []
          })
        })
      const pending = [
        ...pendingDecisions.map((request) => ({ kind: "decision" as const, request })),
        ...timeoutCalls.map((timeout) => ({ kind: "timeout" as const, ...timeout }))
      ]
      if (pending.length === 0) {
        throw new Error(`universe rested without a terminal or a human request after decision round ${round}`)
      }
      expect(pending.length).toBeGreaterThan(0)
      const ranked = pending.map((operation) => ({
        operation,
        rank: generated.schedule[decisionIndex++ % generated.schedule.length] ?? 0
      }))
      const ordered = ranked
        .sort((left, right) => left.rank - right.rank)
        .map(({ operation }) => operation)
      const batchSeed = generated.schedule[decisionIndex++ % generated.schedule.length] ?? 0
      const batch = ordered.slice(0, 1 + batchSeed % ordered.length)
      for (const operation of batch) {
        if (operation.kind === "timeout") {
          const deadlineAt = Number(field(operation.dispatch, "deadlineAt"))
          const remaining = deadlineAt - Date.now()
          if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
          scenario.host.commitRoot(
            scenario.host.self(operation.thread),
            alarmFired({ scheduledFor: deadlineAt, at: Date.now() })
          )
          continue
        }
        const request = operation.request
        const resource = String(field(request, "resource"))
        const match = /^dimension\/([^/]+)\/(\d+)$/u.exec(resource)
        expect(match).not.toBeNull()
        const mission = byKey.get(match?.[1] ?? "")!
        const permission = match?.[2] === "1" ? mission.firstPermission : mission.secondPermission
        scenario.host.commitRoot(scenario.host.self(humanThread), permission === "fail"
          ? {
              type: "PermissionRequestFailed",
              callId: String(field(request, "id")),
              error: "President Morty dropped the portal gun",
              at: decisionAt++
            } as Event
          : {
              type: "PermissionRequestDecided",
              callId: String(field(request, "id")),
              granted: permission === "grant",
              ...(permission === "deny" ? { reason: "President Morty denied this portal" } : {}),
              at: decisionAt++
            } as Event)
      }
      await scenario.drive()
      expect(scenario.host.resting()).toBe(true)
    }

    const answer = scenario.result(turn)
    expect(answer.error).toBeUndefined()
    expect(answer.output).toBeDefined()
    expect(JSON.parse(answer.output ?? "null")).toEqual(missions.map((mission) => ({
      key: mission.key,
      status: expectedStatus(mission)
    })))

    const root = scenario.host.read(ROOT_THREAD)
    const runs = root.filter((event) => event.type === "PackageCalled" && field(event, "name") === "agents.run")
    expect(runs).toHaveLength(missions.length)
    expect(root.filter((event) => event.type === "ResponseReceived" && field(event, "method") === "message")).toHaveLength(missions.length)
    const expectedPermissions = missions.reduce((count, mission) =>
      count + 1 + (mission.firstPermission === "grant" && mission.budget === "grant" ? 1 : 0), 0)
    const expectedPermissionResponses = missions.reduce((count, mission) =>
      count + (mission.firstPermission === "timeout" ? 0 : 1) +
      (mission.firstPermission === "grant" && mission.budget === "grant" && mission.secondPermission !== "timeout" ? 1 : 0), 0)
    const children = childThreadsOf(root)
    const childEvents = runs.flatMap((run) => scenario.host.read(children.get(String(field(run, "callId")))!))
    const dispatchedPermissions = childEvents.filter((event) =>
      event.type === "CallDispatched" && field(event, "method") === "requestPermission"
    )
    const skippedPermissions = childEvents.filter((event) =>
      event.type === "CallSkipped" && field(event, "method") === "requestPermission"
    )
    const humanLog = scenario.host.read(humanThread)
    expect(dispatchedPermissions.length + skippedPermissions.length).toBe(expectedPermissions)
    expect(humanLog.filter((event) => event.type === "PermissionRequestReceived")).toHaveLength(dispatchedPermissions.length)
    expect(humanLog.filter((event) => event.type === "ResponseDelivered" && field(event, "method") === "requestPermission")).toHaveLength(expectedPermissionResponses)

    const expectedTimeouts = expectedPermissions - expectedPermissionResponses
    const timedOut = childEvents.filter((event) =>
      event.type === "CallTimedOut" && field(event, "method") === "requestPermission"
    )
    expect(timedOut).toHaveLength(expectedTimeouts)

    for (const run of runs) {
      const child = scenario.host.read(children.get(String(field(run, "callId")))!)
      expect(child.filter((event) => event.type === "TurnCompleted")).toHaveLength(1)
      expect(child.filter((event) => event.type === "TurnFailed")).toHaveLength(0)
      expect(child.filter((event) =>
        event.type === "CallDispatched" || event.type === "CallSkipped"
      ).length).toBeGreaterThanOrEqual(1)
      const created = child[0] as { readonly type?: unknown; readonly parent?: unknown }
      expect(created.type).toBe("ThreadCreated")
      expect(created.parent).toEqual(threadAddressOf("mem", "main", ROOT_THREAD))
    }
    expect(scenario.host.resting()).toBe(true)
  }), { numRuns: 40 })
}, 60_000)

test("Rick cancels every foreground Morty across generated schedules", async () => {
  await fc.assert(fc.asyncProperty(fc.record({
    children: fc.integer({ min: 1, max: 6 }),
    headroom: fc.integer({ min: 1, max: 3 }),
    schedule: fc.array(fc.nat(), { minLength: 8, maxLength: 32 })
  }), async ({ children, headroom, schedule }) => {
    const concurrency = children + headroom
    let startedChild!: () => void
    const childStarted = new Promise<void>((resolve) => {
      startedChild = resolve
    })
    let releaseChildren!: () => void
    const childrenReleased = new Promise<void>((resolve) => {
      releaseChildren = resolve
    })
    let observedChild = false
    const mind: Mind = async ({ trajectory }) => {
      const head = [...trajectory].reverse().find((event) => event.type === "MessageReceived")
      const brief = String(field(head as Event, "text") ?? "")
      if (brief === "cancel every Morty") {
        const returned = trajectory.some((event) => event.type === "ToolReturned")
        if (returned) return { kind: "complete", output: "too late" }
        return {
          kind: "call",
          callId: "cancel-fanout",
          name: "execute",
          arguments: {
            code: `return await Promise.all(Array.from({ length: ${children} }, (_, morty) =>
              agents.run({ text: "held Morty " + morty })
            ));`
          }
        }
      }
      if (!observedChild) {
        observedChild = true
        startedChild()
      }
      await childrenReleased
      return { kind: "complete", output: `late:${brief}` }
    }
    const assembled = validateActor(actor({
      name: "cancel-citadel",
      methods: agentMethods,
      components: [infer([
        budget([permissions([codeMode([
          agentsPackage({ budget: {} }),
          workspacePackage({ policy: {} })
        ])], {
          authority: {
            address: threadAddressOf("mem", "main", "ag.council-of-ricks"),
            methods: { requestPermission: requestPermissionMethod }
          },
          request: () => undefined
        })]),
        compaction(),
        nativeOutput
      ], TEST_MODEL), budgetAuthority({ decide: (request) => request.grant() })]
    }))
    let pickIndex = 0
    const scenario = actorScenario(assembled, mind, {
      driver: { maxConcurrentThreads: concurrency },
      pick: (dirty) => {
        const threads = [...dirty].sort()
        const choice = schedule[pickIndex++ % schedule.length] ?? 0
        return threads[choice % threads.length]!
      }
    })
    const turn = scenario.enqueue("cancel every Morty")
    const driving = scenario.drive()
    await childStarted
    const cancellation = {
      type: "CancellationRequested",
      request: "rick-cancelled",
      invocation: { method: "message", id: turn, epoch: 0 },
      cause: "requested",
      reason: "Rick closed the portal",
      at: 2
    } as Event
    scenario.host.commitRoot(scenario.host.self(ROOT_THREAD), cancellation)
    scenario.host.commitRoot(scenario.host.self(ROOT_THREAD), {
      ...cancellation,
      request: "rick-cancelled-again",
      at: 3
    } as Event)
    try {
      await driving
    } finally {
      releaseChildren()
    }

    const root = scenario.host.read(ROOT_THREAD)
    const requestAt = root.findIndex((event) => event.type === "CancellationRequested")
    const codeSettledAt = root.findIndex((event) => event.type === "CodeSettled")
    const toolReturnedAt = root.findIndex((event) => event.type === "ToolReturned")
    const cancelledAt = root.findIndex((event) => event.type === "TurnCancelled")
    expect(root.filter((event) => event.type === "CancellationRequested")).toEqual([
      expect.objectContaining({ request: "rick-cancelled", invocation: { method: "message", id: turn, epoch: 0 } })
    ])
    expect(requestAt).toBeGreaterThanOrEqual(0)
    expect(codeSettledAt).toBeGreaterThan(requestAt)
    expect(toolReturnedAt).toBeGreaterThan(codeSettledAt)
    expect(cancelledAt).toBeGreaterThan(toolReturnedAt)
    expect(root.filter((event) => event.type === "TurnCancelled")).toEqual([
      expect.objectContaining({ request: "rick-cancelled", turn, reason: "Rick closed the portal" })
    ])
    expect(root.some((event) => event.type === "TurnCompleted")).toBe(false)

    const runs = root.filter((event) => event.type === "PackageCalled" && field(event, "name") === "agents.run")
    expect(runs).toHaveLength(children)
    for (const run of runs) {
      const child = scenario.host.read(childThreadsOf(root).get(String(field(run, "callId")))!)
      expect(child.filter((event) => event.type === "CancellationRequested")).toHaveLength(1)
      expect(child.filter((event) => event.type === "TurnCancelled")).toHaveLength(1)
      expect(child.some((event) => event.type === "TurnCompleted")).toBe(false)
      expect(child.some((event) => event.type === "TextReturned")).toBe(false)
    }
    expect(scenario.host.resting()).toBe(true)
  }), { numRuns: 20 })
}, 30_000)

test("Rick settles when a foreground Morty is cancelled", async () => {
  let startedChild!: () => void
  const childStarted = new Promise<void>((resolve) => {
    startedChild = resolve
  })
  let releaseChild!: () => void
  const childReleased = new Promise<void>((resolve) => {
    releaseChild = resolve
  })
  const mind: Mind = async ({ trajectory }) => {
    const head = [...trajectory].reverse().find((event) => event.type === "MessageReceived")
    const brief = String(field(head as Event, "text") ?? "")
    if (brief === "wait for Morty") {
      const returned = trajectory.find((event) => event.type === "ToolReturned") as {
        readonly result?: { readonly result?: unknown }
      } | undefined
      if (returned !== undefined) {
        return { kind: "complete", output: JSON.stringify(returned.result?.result) }
      }
      return {
        kind: "call",
        callId: "wait-for-morty",
        name: "execute",
        arguments: {
          code: `return await agents.run({ text: "held Morty" });`
        }
      }
    }
    startedChild()
    await childReleased
    return { kind: "complete", output: "late Morty" }
  }
  const assembled = validateActor(actor({
    name: "cancelled-morty",
    methods: agentMethods,
    components: [infer([
      budget([permissions([codeMode([
        agentsPackage({ budget: {} }),
        workspacePackage({ policy: {} })
      ])], {
        authority: {
          address: threadAddressOf("mem", "main", "ag.council-of-ricks"),
          methods: { requestPermission: requestPermissionMethod }
        },
        request: () => undefined
      })]),
      compaction(),
      nativeOutput
    ], TEST_MODEL), budgetAuthority({ decide: (request) => request.grant() })]
  }))
  const scenario = actorScenario(assembled, mind, {
    driver: { maxConcurrentThreads: 2 }
  })
  const turn = scenario.enqueue("wait for Morty")
  const driving = scenario.drive()
  await childStarted

  const rootBeforeCancellation = scenario.host.read(ROOT_THREAD)
  const childThread = [...childThreadsOf(rootBeforeCancellation).values()][0]!
  const childHead = scenario.host.read(childThread)
    .find((event) => event.type === "MessageReceived")
  if (childHead === undefined) throw new Error("the child has no message turn")
  const childTurn = String(field(childHead, "id"))
  scenario.host.commitRoot(scenario.host.self(childThread), {
    type: "CancellationRequested",
    request: "rick-cancelled-morty",
    invocation: { method: "message", id: childTurn, epoch: 0 },
    cause: "requested",
    reason: "Rick closed Morty's portal",
    at: 2
  } as Event)
  try {
    await driving
  } finally {
    releaseChild()
  }

  expect(JSON.parse(scenario.result(turn).output ?? "null")).toEqual({
    error: "cancelled: Rick closed Morty's portal"
  })
  const root = scenario.host.read(ROOT_THREAD)
  expect(root.filter((event) => event.type === "TurnCompleted")).toHaveLength(1)
  expect(root.filter((event) => event.type === "ResponseReceived" && field(event, "status") === "cancelled")).toEqual([
    expect.objectContaining({ cause: "requested", reason: "Rick closed Morty's portal" })
  ])
  const child = scenario.host.read(childThread)
  expect(child.filter((event) => event.type === "TurnCancelled")).toEqual([
    expect.objectContaining({ request: "rick-cancelled-morty", reason: "Rick closed Morty's portal" })
  ])
  expect(scenario.host.resting()).toBe(true)
}, 30_000)
