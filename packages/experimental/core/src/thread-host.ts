import { RuntimeError } from "./errors"
import { Effect, Layer } from "effect"
import type { ActorRuntime } from "./host"
import type { Atom } from "./atom"
import type { Journal } from "./journal"
import { createSupervisor, ThreadProvisioner, type SupervisorEvent, type ThreadCoordinate } from "./supervisor"
import { invocationLedger, type InvocationEvent, type InvocationOptions, type ThreadMethods } from "./invocation"

export interface ThreadStorage<Event extends object> {
  readonly supervisor: (actor: string, instance: string) => Journal<SupervisorEvent>
  readonly thread: (coordinate: ThreadCoordinate) => Journal<Event>
  readonly invocations: (coordinate: ThreadCoordinate) => Journal<InvocationEvent>
  readonly close: () => Promise<void>
}

export interface ManagedThread<Methods, State> {
  readonly methods: Methods
  readonly get: <Value>(node: Atom<Value>) => Value
  readonly getState: () => State
  readonly wait: () => Promise<void>
  readonly close: () => Promise<void>
}

export interface HostedActor<Event extends object, Services, Methods, State> {
  (options: {
    readonly services: (runtime: ActorRuntime<Event>) => Layer.Layer<Services, Error>
    readonly journal?: Journal<Event>
  }): Promise<ManagedThread<Methods, State>>
  readonly actorName: string
}

// createThreadHost allocates scoped thread identities and serializes local allocation and invocation admission.
export function createThreadHost<Event extends object, Services, Methods extends Readonly<Record<string, (...args: never[]) => Promise<void>>>, State>(options: {
  readonly actor: HostedActor<Event, Services, Methods, State>
  readonly storage: ThreadStorage<Event>
  readonly layersFor: (coordinate: ThreadCoordinate, runtime: ActorRuntime<Event>) => Layer.Layer<Services, Error>
  readonly generateName?: () => string
}) {
  const supervisors = new Map<string, Promise<Awaited<ReturnType<typeof createSupervisor>>>>()
  const threads = new Map<string, Promise<ManagedThread<Methods, State>>>()
  const ledgers = new Map<string, ReturnType<typeof invocationLedger>>()
  const queues = new Map<string, Promise<unknown>>()
  let closed = false
  let closing: Promise<void> | undefined
  const check = () => { if (closed) throw new RuntimeError("Thread host is closed") }
  const serialize = <Value>(key: string, run: () => Promise<Value>): Promise<Value> => {
    check()
    const promise = (queues.get(key) ?? Promise.resolve()).then(run, run)
    queues.set(key, promise)
    void promise.finally(() => { if (queues.get(key) === promise) queues.delete(key) }).catch(() => {})
    return promise
  }
  const identity = (coordinate: ThreadCoordinate) => JSON.stringify([coordinate.actor, coordinate.instance, coordinate.thread])
  const open = (coordinate: ThreadCoordinate) => {
    const key = identity(coordinate)
    let pending = threads.get(key)
    if (!pending) {
      pending = options.actor({ journal: options.storage.thread(coordinate), services: runtime => options.layersFor(coordinate, runtime) })
      threads.set(key, pending)
      void pending.catch(() => { if (threads.get(key) === pending) threads.delete(key) })
    }
    return pending
  }
  const supervisorFor = (instance: string) => {
    if (!instance) throw new RuntimeError("Actor instance must be nonempty")
    let pending = supervisors.get(instance)
    if (!pending) {
      pending = createSupervisor({
        journal: options.storage.supervisor(options.actor.actorName, instance),
        services: () => Layer.succeed(ThreadProvisioner, {
          provision: allocation => Effect.tryPromise({ try: async () => { await open(allocation.coordinate) }, catch: RuntimeError.from }),
        }),
      }).then(async supervisor => {
        try { await supervisor.resume(); return supervisor } catch (error) { await supervisor.close(); throw error }
      })
      supervisors.set(instance, pending)
      void pending.catch(() => { if (supervisors.get(instance) === pending) supervisors.delete(instance) })
    }
    return pending
  }
  const reference = async (coordinate: ThreadCoordinate) => {
    const thread = await open(coordinate)
    const key = identity(coordinate)
    let ledger = ledgers.get(key)
    if (!ledger) {
      ledger = invocationLedger(options.storage.invocations(coordinate))
      ledgers.set(key, ledger)
    }
    const invocations = await ledger
    const methods = Object.fromEntries(Object.entries(thread.methods).map(([name, method]) => [name, async (...values: unknown[]) => {
      const input = structuredClone(values.slice(0, -1))
      const invocation = values.at(-1) as InvocationOptions | undefined
      if (!invocation || typeof invocation.key !== "string" || !invocation.key) return Promise.reject(new RuntimeError("Invocation key is required"))
      const invocationKey = invocation.key
      return serialize(`invoke:${key}`, () => invocations.invoke(invocationKey, name, input, () => method(...input as never[])))
    }])) as unknown as ThreadMethods<Methods>
    return { coordinate: Object.freeze({ ...coordinate }), methods, get: thread.get, getState: thread.getState, wait: thread.wait, invocation: invocations.get }
  }
  const allocate = (instance: string, parent: ThreadCoordinate | undefined, suppliedName?: string) => serialize(`allocate:${instance}`, async () => {
    if (parent && (parent.actor !== options.actor.actorName || parent.instance !== instance)) throw new RuntimeError("Parent belongs to another actor instance")
    const supervisor = await supervisorFor(instance)
    const directory = supervisor.getState().threads
    const ancestor = parent ? directory.find(entry => entry.coordinate.thread === parent.thread && entry.status === "registered") : undefined
    if (parent && !ancestor) throw new RuntimeError("Unknown parent thread")
    const name = suppliedName ?? (options.generateName ?? crypto.randomUUID)()
    if (!name || name.includes("/")) throw new RuntimeError("Thread name must be nonempty and contain no slash")
    const existing = directory.find(entry => entry.name === name && entry.parent === (parent?.thread ?? null))
    if (existing) {
      if (suppliedName === undefined) throw new RuntimeError("Generated thread name already exists; supply a different name or generator")
      await supervisor.resume()
      return reference(existing.coordinate)
    }
    const thread = directory.some(entry => entry.coordinate.thread === name) ? `${name}-${crypto.randomUUID()}` : name
    if (directory.some(entry => entry.coordinate.thread === thread)) throw new RuntimeError("Thread identity collision")
    const coordinate = { actor: options.actor.actorName, instance, thread }
    await supervisor.methods.requestThread({ coordinate, name, parent: parent?.thread ?? null, depth: ancestor ? ancestor.depth + 1 : 0 })
    return reference(coordinate)
  })
  return {
    actor: options.actor.actorName,
    getThread: async (input: { readonly instance: string; readonly thread: string }) => {
      check()
      const supervisor = await supervisorFor(input.instance)
      const entry = supervisor.getState().threads.find(thread => thread.coordinate.thread === input.thread && thread.status === "registered")
      return entry ? reference(entry.coordinate) : undefined
    },
    allocateRootThread: async (input: { readonly instance: string; readonly name?: string }) => allocate(input.instance, undefined, input.name),
    allocateChildThread: async (input: { readonly parent: ThreadCoordinate; readonly name?: string }) => allocate(input.parent.instance, input.parent, input.name),
    close: () => closing ??= (async () => {
      closed = true
      await Promise.allSettled(queues.values())
      const results = await Promise.allSettled([...supervisors.values(), ...threads.values()].map(async pending => (await pending).close()))
      await options.storage.close()
      const failure = results.find(result => result.status === "rejected")
      if (failure?.status === "rejected") throw failure.reason
    })(),
  }
}
