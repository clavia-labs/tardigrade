import { createHash } from "node:crypto"
import type { Boxd, Machine, MachineSize, MachineSpec } from "@boxd-sh/sdk"
import { Effect, Layer } from "effect"
import type { Workspace } from "@clavia/tardigrade-libraries/workspace/index"
import { WorkspaceError, type WorkspaceBackend, type WorkspaceIdempotencyStore, type WorkspaceReadOptions } from "@clavia/tardigrade-libraries/workspace/index"
import { containerWorkspace, DEFAULT_CONTAINER_WORKSPACE_POLICY, DEFAULT_WORKSPACE_RELEASE, type ContainerWorkspacePolicy, type WorkspaceContainer, type WorkspaceFiles, type WorkspaceRelease } from "../shared/workspace/container"
import { workspaceNetworkPolicy, type WorkspaceNetworkPolicy } from "../shared/workspace/network"

type Machines = Boxd["machines"]

// BoxdWorkspaceClient is the part of the @boxd-sh/sdk client that a boxd workspace calls; `new Boxd()` satisfies it.
export interface BoxdWorkspaceClient {
  readonly machines: Pick<Machines, "create" | "list" | "get" | "start" | "hibernate" | "delete" | "waitUntilReady" | "streamExec"> & {
    readonly fs: Pick<Machines["fs"], "readStream" | "write" | "mkdir">
  }
}

export const DEFAULT_BOXD_WORKSPACE_DIRECTORY = "/home/boxd/workspace"
export const DEFAULT_BOXD_WORKSPACE_NAME_PREFIX = "tardie-"

export interface BoxdWorkspaceOptions extends WorkspaceReadOptions {
  readonly client: BoxdWorkspaceClient
  // name identifies the computer within its region; a host that restarts adopts the computer with this name.
  readonly name: string
  readonly org?: string
  readonly region?: string
  readonly size?: MachineSize
  readonly snapshot?: string
  readonly labels?: Readonly<Record<string, string>>
  readonly directory?: string
  readonly network?: WorkspaceNetworkPolicy
  readonly idempotency?: WorkspaceIdempotencyStore
  readonly policy?: Partial<ContainerWorkspacePolicy>
  // release deletes, hibernates, or leaves the computer running for destroy, retain, or unmount.
  readonly release?: WorkspaceRelease
}

// boxdEgress maps a workspace network policy onto a boxd egress allowlist; an empty list leaves egress unrestricted.
function boxdEgress(policy?: WorkspaceNetworkPolicy): readonly string[] {
  const normalized = workspaceNetworkPolicy(policy)
  return normalized.mode === "none" ? ["none"] : normalized.mode === "all" ? [] : normalized.hosts
}

// boxdWorkspaceName names the computer for a thread coordinate with the prefix and the first 16 hex digits of a SHA-256 of actor, instance, and thread.
export function boxdWorkspaceName(coordinate: { readonly actor: string; readonly instance: string; readonly thread: string }, prefix = DEFAULT_BOXD_WORKSPACE_NAME_PREFIX): string {
  return `${prefix}${createHash("sha256").update(JSON.stringify([coordinate.actor, coordinate.instance, coordinate.thread])).digest("hex").slice(0, 16)}`
}

// boxdWorkspaceSpec is the spec a new workspace computer is created with; isolation is always on because the shell runs model-chosen commands.
function boxdWorkspaceSpec(options: Pick<BoxdWorkspaceOptions, "size" | "snapshot" | "labels" | "network">): MachineSpec {
  const egress = boxdEgress(options.network)
  return {
    version: 1, isolated: true,
    ...(egress.length ? { egress: [...egress] } : {}),
    ...(options.size ? { size: options.size } : {}),
    ...(options.snapshot ? { base: { snapshot: options.snapshot } } : {}),
    ...(options.labels ? { labels: { ...options.labels } } : {}),
  }
}

// boxdWorkspaceId is the idempotency identity of a named computer, so replay after a host restart finds the saved outcomes.
const boxdWorkspaceId = (options: Pick<BoxdWorkspaceOptions, "org" | "name">): string => JSON.stringify(["boxd", options.org ?? null, options.name])

const errorName = (cause: unknown) => cause instanceof Error ? cause.name : undefined
const isGone = (cause: unknown) => errorName(cause) === "NotFoundError"
const isStopped = (cause: unknown) => errorName(cause) === "ConflictError" && cause instanceof Error && /\bstopped\b/.test(cause.message)
const ifPresent = <A>(pending: Promise<A>) => pending.catch((cause: unknown) => { if (isGone(cause)) return undefined; throw cause })
const sorted = (values: readonly string[]) => JSON.stringify([...values].sort())

function channel() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const readable = new ReadableStream<Uint8Array>({ start: value => { controller = value } })
  return { readable, controller }
}

// boxdComputer adapts one named boxd computer to the container contract; isolation and egress are checked before a computer is used.
function boxdComputer(options: BoxdWorkspaceOptions & { readonly startupTimeoutMs: number; readonly startupPollIntervalMs: number }) {
  const { machines } = options.client
  const spec = boxdWorkspaceSpec(options)
  const egress = sorted(spec.egress ?? [])
  let id: string | undefined
  let region = options.region
  let running = false
  let starting: Promise<void> = Promise.resolve()
  let stopped = () => {}
  let watched: Promise<void> = Promise.resolve()
  const at = () => region ? { region } : {}
  const lose = () => { running = false; stopped() }
  const current = () => {
    if (id === undefined) throw new WorkspaceError(`Computer ${options.name} has not started`)
    return id
  }
  const ready = (computer: string) => machines.waitUntilReady(computer, { ...at(), timeout: options.startupTimeoutMs, pollInterval: options.startupPollIntervalMs })
  const wake = (computer: string) => machines.start(computer, at()).then(() => ready(computer))
  const verify = (machine: Machine) => {
    if (!machine.networking.isolated) throw new WorkspaceError(`Computer ${machine.name} is not isolated; workspace computers run model-chosen commands`)
    const actual = sorted(machine.egressAllow)
    if (actual !== egress) throw new WorkspaceError(`Workspace network policy is fixed at creation: computer ${machine.name} has egress ${actual}, requested ${egress}`)
  }
  // find returns the computer with the name; it refuses to choose when the name is in two regions, or when a region that did not answer may hold it.
  const find = async () => {
    const listed = await machines.list({ ...(options.org ? { org: options.org } : {}), region: options.region ?? "all" })
    const named = listed.filter(machine => machine.name === options.name)
    if (named.length > 1) throw new WorkspaceError(`Computer ${options.name} exists in regions ${named.map(machine => machine.region).join(" and ")}; set region to choose one`)
    if (listed.unavailable.length) throw new WorkspaceError(`Regions ${listed.unavailable.join(", ")} did not answer and may hold computer ${options.name}; retry, or set region`)
    return named[0]
  }
  // call retries once after starting a stopped computer; suspended and hibernated computers wake on any call.
  const call = async <A>(run: (computer: string) => Promise<A>): Promise<A> => {
    const computer = current()
    try { return await run(computer) } catch (cause) {
      if (isGone(cause)) lose()
      if (!isStopped(cause)) throw cause
      await wake(computer)
      return run(computer)
    }
  }
  // begin adopts a verified computer with the name or creates one; a created computer is owned from create, so release reaches it when startup fails.
  const begin = async () => {
    const known = id === undefined ? undefined : await ifPresent(machines.get(id, at()))
    const adopted = known ?? await find()
    if (adopted) verify(adopted)
    const machine = adopted ?? await machines.create({ name: options.name, ...(options.org ? { org: options.org } : {}), ...(options.region ? { region: options.region } : {}), spec })
    id = machine.id
    region = machine.region ?? region
    if (!adopted) verify(machine)
    if (machine.status === "failed" || machine.status === "destroyed") throw new WorkspaceError(`Computer ${machine.name} is ${machine.status}`)
    if (machine.status === "stopped") await wake(machine.id)
    else if (machine.status === "pending" || machine.status === "starting") await ready(machine.id)
    running = true
    watched = new Promise(resolve => { stopped = resolve })
  }
  const container: WorkspaceContainer = {
    get running() { return running },
    exec: async (command, execOptions) => {
      const computer = current()
      const signal = execOptions?.signal
      const stdout = channel()
      const stderr = channel()
      const exitCode = (async () => {
        let close = () => {}
        let cancel = () => {}
        // aborted rejects on abort, so a caller is released while a stopped computer starts and when a stream closed before its call connects never settles (test/bun/workspace/boxd.test.ts, "a command whose stream never settles still times out").
        const aborted = new Promise<never>((_, reject) => { cancel = () => { close(); reject(signal?.reason) } })
        signal?.addEventListener("abort", cancel, { once: true })
        try {
          for (let attempt = 0; ; attempt++) {
            signal?.throwIfAborted()
            const stream = machines.streamExec(computer, { command, closeStdin: true, ...(execOptions?.cwd ? { cwd: execOptions.cwd } : {}), ...at() })
            close = () => stream.close()
            let emitted = false
            const forward = async (source: AsyncIterable<Uint8Array>, target: ReadableStreamDefaultController<Uint8Array>) => {
              for await (const chunk of source) { emitted = true; target.enqueue(chunk) }
            }
            try {
              const [, , code] = await Promise.race([Promise.all([forward(stream.stdout, stdout.controller), forward(stream.stderr, stderr.controller), stream.wait()]), aborted])
              // A negative status means the call ended without the command reporting one, which the server returns for a deleted computer.
              if (code < 0) {
                if (!await ifPresent(machines.get(computer, at()))) lose()
                throw new WorkspaceError(`Command on computer ${options.name} ended without an exit status`)
              }
              stdout.controller.close()
              stderr.controller.close()
              return code
            } catch (cause) {
              if (attempt === 0 && !emitted && isStopped(cause) && !signal?.aborted) { await Promise.race([wake(computer), aborted]); continue }
              throw cause
            }
          }
        } catch (cause) {
          if (isGone(cause)) lose()
          stdout.controller.error(cause)
          stderr.controller.error(cause)
          throw cause
        } finally { signal?.removeEventListener("abort", cancel) }
      })()
      return { stdout: stdout.readable, stderr: stderr.readable, exitCode }
    },
    monitor: () => watched,
    destroy: async () => {
      if (id === undefined) return
      await ifPresent(machines.delete(id, at()))
      id = undefined
      lose()
    },
  }
  const files: WorkspaceFiles = {
    readFile: (path, fileOptions) => call(async computer => {
      fileOptions?.signal?.throwIfAborted()
      const chunks = machines.fs.readStream(computer, path, at())[Symbol.asyncIterator]()
      const first = await chunks.next()
      return new Response(new ReadableStream<Uint8Array>({
        start: controller => { if (first.done) controller.close(); else controller.enqueue(first.value) },
        pull: async controller => { const next = await chunks.next(); if (next.done) controller.close(); else controller.enqueue(next.value) },
        cancel: async () => { await chunks.return?.() },
      }))
    }),
    writeFile: (path, content, fileOptions) => call(async computer => { fileOptions?.signal?.throwIfAborted(); await machines.fs.write(computer, path, content, at()) }),
    // mkdir creates missing parents; boxd's fs.mkdir is recursive and accepts an existing directory.
    mkdir: (path, fileOptions) => call(async computer => { fileOptions?.signal?.throwIfAborted(); await machines.fs.mkdir(computer, path, at()) }),
  }
  // release applies the workspace release once a start the caller abandoned has settled; a computer that never finished starting is deleted under "destroy" and left as it is under "retain".
  const release = async (mode: WorkspaceRelease) => {
    await starting.catch(() => undefined)
    if (mode === "destroy") await container.destroy()
    else if (mode === "retain" && id !== undefined && running) {
      await ifPresent(machines.hibernate(id, at()))
      lose()
    }
  }
  return { container, files, start: () => (starting = begin()), release }
}

// boxdWorkspace supplies file and shell operations in an isolated boxd computer; release "retain" keeps the computer and its disk for the next host.
export function boxdWorkspace(options: BoxdWorkspaceOptions): Layer.Layer<Workspace | WorkspaceBackend, WorkspaceError> {
  return Layer.unwrap(Effect.try({ try: () => {
    if (typeof options.name !== "string" || !options.name.trim()) throw new WorkspaceError("A boxd workspace requires a computer name")
    const release = options.release ?? DEFAULT_WORKSPACE_RELEASE
    if (release !== "destroy" && release !== "retain" && release !== "unmount") throw new WorkspaceError("release must be destroy, retain, or unmount")
    const policy = { ...DEFAULT_CONTAINER_WORKSPACE_POLICY, ...options.policy }
    const computer = boxdComputer({ ...options, startupTimeoutMs: policy.startupTimeoutMs, startupPollIntervalMs: policy.startupPollIntervalMs })
    const { idempotency, ...rest } = options
    // The container layer keeps the computer on release and the finalizer below applies release, because a computer exists from create, before the container contract reports it running.
    const workspace = containerWorkspace({
      ...rest, release: "retain",
      container: computer.container, files: computer.files, start: computer.start,
      directory: options.directory ?? DEFAULT_BOXD_WORKSPACE_DIRECTORY,
      ...(idempotency ? { idempotency: { workspaceId: boxdWorkspaceId(options), store: idempotency } } : {}),
    })
    return Layer.merge(workspace, Layer.effectDiscard(Effect.addFinalizer(() => Effect.tryPromise({ try: () => computer.release(release), catch: WorkspaceError.from }).pipe(Effect.orDie))))
  }, catch: WorkspaceError.from }))
}
