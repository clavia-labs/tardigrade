import { expect, test } from "bun:test"
import fc from "fast-check"
import { Schema } from "effect"
import { eventAt, type Event } from "../event"
import { legacyActorMethod } from "../actor/method-compat"
import { formatThreadAddress } from "../transport/endpoint"
import { linkOf } from "../transport/link"
import { invocationCoordinateKey, type InvocationCoordinate } from "./invocation"
import { invocationDetached, invocationDetachmentKeys, replyStateOf, reduceReplyState, type ReplyState } from "./detach"
import { callStateOf, reduceCallState, type CallState } from "./result"
import { forkBatchOf } from "../log/fork"
import { threadCreated, openChildInvocationsOf } from "./relations"
import { initialMethodResponseState, reduceMethodResponseState, methodResponseTransitions, methodResponseDerivation } from "./respond"
import { earliestDeadlineOf, methodTimeoutDerivation, initialMethodTimeoutState, reduceMethodTimeoutState, methodTimeoutTransitions } from "./timeout"

const coordinate = fc.record({
  target: fc.record({ actor: fc.constant("worker"), instance: fc.constant("main"), thread: fc.stringMatching(/^[a-z]{1,8}$/) }),
  invocation: fc.record({ method: fc.constant("work"), id: fc.string({ minLength: 1, maxLength: 12 }), epoch: fc.nat({ max: 8 }) })
})
const parent = { actor: "worker", instance: "main", thread: "parent" }
const restore = (events: ReadonlyArray<Event>): Event[] => JSON.parse(JSON.stringify(events)) as Event[]
const positions = (events: ReadonlyArray<Event>) => events.map((event, index) => eventAt(event, index + 1))
const detach = (reference: InvocationCoordinate, direction: "incoming" | "outgoing", at = 2) => invocationDetached({ reference, direction, at })
const response = (reference: InvocationCoordinate, status: "completed" | "failed" | "cancelled", at: number): Event => ({
  type: "ResponseReceived", reference, method: reference.invocation.method, call: reference.invocation.id,
  epoch: reference.invocation.epoch, id: `reply-${at}`, from: formatThreadAddress(reference.target),
  status, output: "answer", error: "failure", cause: "requested", at
})
const accepted = (reference: InvocationCoordinate, caller = parent): Event => ({
  type: "Started", id: reference.invocation.id, call: { invocation: reference.invocation }, link: linkOf(caller, reference.target), at: 0
})
const delivered = (reference: InvocationCoordinate, at: number): Event => ({
  type: "ResponseDelivered", method: reference.invocation.method, call: reference.invocation.id, epoch: reference.invocation.epoch, at
})
const methods = {
  work: legacyActorMethod({
    input: Schema.String, output: Schema.String,
    event: ({ invocation, at }) => ({ type: "Started", id: invocation.id, at }),
    state: (events) => events.some((event) => event.type === "Finished")
      ? { status: "completed", output: "answer" } : { status: "pending" }
  })
}

test("call terminals absorb duplicates and late events across replay boundaries", () => {
  fc.assert(fc.property(coordinate, fc.array(fc.record({
    kind: fc.constantFrom("completed", "failed", "cancelled", "timeout", "detach", "incoming", "foreign", "noise"),
    at: fc.nat({ max: 100 }), duplicate: fc.boolean()
  }), { maxLength: 35 }), fc.nat(), (reference, commands, cut) => {
    const dispatch: Event = { type: "CallDispatched", reference, method: "work", id: reference.invocation.id,
      epoch: reference.invocation.epoch, target: formatThreadAddress(reference.target), timeoutMs: 10, deadlineAt: 10, at: 0 }
    const history = [dispatch]
    let expected: CallState["status"] = "pending"
    let terminal: Event | undefined
    let incremental: CallState = { status: "pending" }
    for (const command of commands) {
      const event: Event = command.kind === "detach" ? detach(reference, "outgoing", command.at)
        : command.kind === "incoming" ? detach(reference, "incoming", command.at)
        : command.kind === "foreign" ? detach({ ...reference, invocation: { ...reference.invocation, epoch: reference.invocation.epoch + 1 } }, "outgoing", command.at)
        : command.kind === "timeout" ? { type: "CallTimedOut", reference, method: "work", call: reference.invocation.id,
          target: formatThreadAddress(reference.target), timeoutMs: 10, deadlineAt: 10, at: command.at }
        : command.kind === "noise" ? { type: "Noise", at: command.at }
        : response(reference, command.kind, command.at)
      if (expected === "pending" && !["incoming", "foreign", "noise"].includes(command.kind)) {
        expected = command.kind === "detach" ? "detached" : command.kind === "timeout" ? "timed-out" : "received"
        terminal = event
      }
      for (const occurrence of command.duplicate ? [event, event] : [event]) {
        history.push(occurrence)
        incremental = reduceCallState(incremental, occurrence, reference)
      }
      const oracle: unknown = terminal === undefined ? { status: "pending" }
        : expected === "detached" ? { status: expected, detachment: terminal }
        : expected === "timed-out" ? { status: expected, timeout: terminal } : { status: expected, response: terminal }
      expect(oracle).toEqual(incremental)
      expect(oracle).toEqual(callStateOf(restore(history), reference))
      expect(earliestDeadlineOf(history)).toBe(expected === "pending" ? 10 : undefined)
      const alarmHistory = positions([...history, { type: "AlarmFired", scheduledFor: 10, at: 10 }])
      const projected = alarmHistory.reduce(reduceMethodTimeoutState, initialMethodTimeoutState())
      expect(methodTimeoutDerivation(alarmHistory).map((transition) => transition.key))
        .toEqual(methodTimeoutTransitions({}, new Map(), projected).map((transition) => transition.key))
      expect(methodTimeoutDerivation(alarmHistory)).toHaveLength(expected === "pending" ? 1 : 0)
    }
    const split = cut % (history.length + 1)
    const resumed = restore(history.slice(split)).reduce((state, event) => reduceCallState(state, event, reference), callStateOf(restore(history.slice(0, split)), reference))
    expect(resumed).toEqual(incremental)
  }), { numRuns: 200 })
})

test("reply ownership and computation settle independently under complete and incremental replay", () => {
  fc.assert(fc.property(coordinate, fc.array(fc.record({
    kind: fc.constantFrom("finish", "detach", "sent", "outgoing", "foreign", "noise"),
    duplicate: fc.boolean(), at: fc.nat({ max: 100 })
  }), { maxLength: 35 }), (reference, commands) => {
    let history = positions([accepted(reference)])
    let projected = history.reduce(reduceMethodResponseState, initialMethodResponseState())
    let reply: ReplyState = { status: "pending" }
    let expected: ReplyState["status"] = "pending"
    let finished = false
    for (const command of commands) {
      const event = command.kind === "detach" ? detach(reference, "incoming", command.at)
        : command.kind === "sent" ? delivered(reference, command.at)
        : command.kind === "outgoing" ? detach(reference, "outgoing", command.at)
        : command.kind === "foreign" ? detach({ ...reference, target: { ...reference.target, thread: reference.target.thread + "-fork" } }, "incoming", command.at)
        : { type: command.kind === "finish" ? "Finished" : "Noise", at: command.at }
      if (command.kind === "finish") finished = true
      if (expected === "pending" && (command.kind === "detach" || command.kind === "sent")) expected = command.kind === "detach" ? "detached" : "sent"
      for (const occurrence of command.duplicate ? [event, event] : [event]) {
        const positioned = eventAt(occurrence, history.length + 1)
        history.push(positioned)
        projected = reduceMethodResponseState(projected, positioned)
        reply = reduceReplyState(reply, positioned, reference)
      }
      expect(reply.status).toBe(expected)
      expect(projected.replies.get(invocationCoordinateKey(reference)) ?? { status: "pending" }).toEqual(reply)
      expect(replyStateOf(restore(history), reference)).toEqual(reply)
      const computation = methods.work.state(history, reference.invocation)
      expect(computation?.status).toBe(finished ? "completed" : "pending")
      const transitions = methodResponseTransitions(methods, projected, () => computation)
      expect(transitions).toHaveLength(finished && expected === "pending" ? 1 : 0)
      expect(transitions.map((transition) => transition.key)).toEqual(methodResponseDerivation(methods)(history).map((transition) => transition.key))
      history = positions(restore(history))
      projected = history.reduce(reduceMethodResponseState, initialMethodResponseState())
    }
  }), { numRuns: 200 })
})

const tree = fc.array(fc.record({ parent: fc.nat(), received: fc.boolean(), sent: fc.boolean() }), { minLength: 2, maxLength: 10 })

test("detachment closes copied tree boundaries while preserving original obligations and settled outcomes", () => {
  fc.assert(fc.property(tree, fc.string({ minLength: 1, maxLength: 8 }), fc.nat({ max: 8 }), (nodes, id, epoch) => {
    const address = (index: number) => ({ actor: "worker", instance: "main", thread: `node-${index}` })
    const references = nodes.map((_, index) => ({ target: address(index + 1), invocation: { method: "work", id, epoch } }))
    const logs: Event[][] = Array.from({ length: nodes.length + 1 }, (_, index) => [threadCreated(address(index), undefined, 0)])
    for (const [index, node] of nodes.entries()) {
      const parentIndex = node.parent % (index + 1)
      const reference = references[index]!
      logs[parentIndex]!.push({ type: "InvocationLinked", parent: reference.invocation,
        owner: { type: "invocation", ref: reference.invocation }, child: { invocation: reference.invocation },
        target: formatThreadAddress(reference.target), at: 0 })
      logs[index + 1]!.push(accepted(reference, address(parentIndex)))
      if (node.received) logs[parentIndex]!.push(response(reference, "completed", 1))
      if (node.sent || node.received) logs[index + 1]!.push(delivered(reference, 1))
    }
    const snapshot = JSON.stringify(logs)
    for (const [index, original] of logs.entries()) {
      const outgoing = references.filter((_, child) => nodes[child]!.parent % (child + 1) === index)
      const incoming = index === 0 ? undefined : references[index - 1]!
      const events = references.flatMap((ref, child) => nodes[child]!.parent % (child + 1) === index && !nodes[child]!.received ? [detach(ref, "outgoing")] : [])
      if (incoming !== undefined && !(nodes[index - 1]!.sent || nodes[index - 1]!.received)) events.push(detach(incoming, "incoming"))
      const destination = `fork-${index}`
      const fork = [threadCreated({ ...address(index), thread: destination }, undefined, 2),
        ...forkBatchOf(restore(original), original.length, address(index), destination, 2)]
      expect(fork.filter((event) => event.type === "InvocationDetached")).toEqual(events)
      expect(new Set(events.map(invocationDetachmentKeys.keyOf)).size).toBe(events.length)
      expect(openChildInvocationsOf(fork)).toEqual([])
      for (const ref of outgoing) {
        const before = callStateOf(original, ref)
        expect(callStateOf(fork, ref)).toEqual(before.status === "pending" ? { status: "detached", detachment: detach(ref, "outgoing") } : before)
      }
      if (incoming !== undefined) {
        const before = replyStateOf(original, incoming)
        expect(replyStateOf(fork, incoming)).toEqual(before.status === "pending" ? { status: "detached", detachment: detach(incoming, "incoming") } : before)
      }
      const forkAgain = [threadCreated({ ...address(index), thread: `second-${index}` }, undefined, 3),
        ...forkBatchOf(restore(fork), fork.length, { ...address(index), thread: destination }, `second-${index}`, 3)]
      expect(forkAgain.filter((event) => event.type === "InvocationDetached")).toEqual(events)
      for (const ref of outgoing) expect(callStateOf(forkAgain, ref)).toEqual(callStateOf(fork, ref))
      if (incoming !== undefined) expect(replyStateOf(forkAgain, incoming)).toEqual(replyStateOf(fork, incoming))
    }
    expect(JSON.stringify(logs)).toBe(snapshot)
  }), { numRuns: 200 })
})

test("detachment storage keys isolate all coordinate fields and absorb repeated deliveries", () => {
  fc.assert(fc.property(coordinate, fc.string({ minLength: 1, maxLength: 12 }), fc.nat({ max: 100 }), (reference, suffix, at) => {
    const references = [reference,
      ...(["actor", "instance", "thread"] as const).map((field) => ({ ...reference, target: { ...reference.target, [field]: reference.target[field] + suffix } })),
      ...(["method", "id"] as const).map((field) => ({ ...reference, invocation: { ...reference.invocation, [field]: reference.invocation[field] + suffix } })),
      { ...reference, invocation: { ...reference.invocation, epoch: reference.invocation.epoch + 1 } }
    ]
    const events = references.flatMap((ref) => [detach(ref, "incoming", at), detach(ref, "outgoing", at)])
    const keys = events.map(invocationDetachmentKeys.keyOf)
    expect(new Set(keys).size).toBe(events.length)
    expect(events.map((event) => invocationDetachmentKeys.keyOf({ ...event, at: at + 1 }))).toEqual(keys)
    for (const [index, ref] of references.entries()) {
      const foreign = events.filter((_, eventIndex) => Math.floor(eventIndex / 2) !== index)
      expect(callStateOf(foreign, ref).status).toBe("pending")
      expect(replyStateOf(foreign, ref).status).toBe("pending")
      const once = [events[index * 2]!, events[index * 2 + 1]!]
      const repeated = [...once, ...foreign, ...restore(once)]
      expect(callStateOf(repeated, ref)).toEqual(callStateOf(once, ref))
      expect(replyStateOf(repeated, ref)).toEqual(replyStateOf(once, ref))
    }
  }), { numRuns: 200 })
})
