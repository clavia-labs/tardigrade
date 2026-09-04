import { Button } from "@base-ui/react/button"
import { Input } from "@base-ui/react/input"
import { ArrowUp, CaretRight, ChatCircle, CircleNotch, Code, Package as PackageIcon, Plus, X } from "@phosphor-icons/react"
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Worm } from "lucide-react"
import { StrictMode, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactElement } from "react"
import { createRoot } from "react-dom/client"
import { agentMethods } from "tardie"
import { makeActorClient, ProblemError, type Event, type EventRow, type InferDelta } from "@clavia/tardigrade-client"

import "./styles.css"

const actor = "main"
const baseUrl = "http://localhost:4242"
const client = makeActorClient({ baseUrl, methods: agentMethods })
const queryClient = new QueryClient()
const thread = localStorage.getItem("tardigrade.chat.thread") ?? crypto.randomUUID()

localStorage.setItem("tardigrade.chat.thread", thread)

const eventsKey = ["events", actor, thread] as const

const startThread = () => {
  localStorage.setItem("tardigrade.chat.thread", crypto.randomUUID())
  location.reload()
}

const openThread = (id: string) => {
  localStorage.setItem("tardigrade.chat.thread", id)
  location.reload()
}

const threadLabel = (lastAt: number | undefined): string => lastAt === undefined
  ? "New thread"
  : new Date(lastAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

const merge = (current: ReadonlyArray<EventRow>, row: EventRow): ReadonlyArray<EventRow> =>
  current.some((item) => item.seq === row.seq) ? current : [...current, row].sort((a, b) => a.seq - b.seq)

const readEvents = async (id: string): Promise<ReadonlyArray<EventRow>> => {
  try {
    return await client.events(actor, id)
  } catch (error) {
    if (error instanceof ProblemError && error.status === 404) return []
    throw error
  }
}

const value = (event: Event, field: string): string | undefined =>
  typeof event[field] === "string" ? event[field] : undefined

const toolContent = (event: Event): string => {
  const args = event.arguments
  if (typeof args === "object" && args !== null && "code" in args && typeof args.code === "string") return args.code
  return JSON.stringify(args, undefined, 2) ?? ""
}

const toolTitle = (event: Event, complete: boolean): string => {
  const name = value(event, "name") ?? "tool"
  if (name === "execute") return complete ? "Executed code" : "Executing code"
  const [packageName, methodName] = name.split(".", 2)
  const target = methodName === undefined ? packageName : `${packageName} · ${methodName}`
  return complete ? `Called ${target}` : `Calling ${target}`
}

const childThread = (event: Event): string | undefined => value(event, "callId")

const waitingForResponse = (events: ReadonlyArray<EventRow>): boolean => {
  const started = events.findLastIndex(({ event }) => event.type === "ModelCalled")
  if (started === -1) return false
  return !events.slice(started + 1).some(({ event }) =>
    ["TextReturned", "ToolCalled", "TurnCompleted", "TurnFailed"].includes(event.type)
  )
}

interface StreamingText {
  readonly physicalAttempt: string
  readonly nextSequence: number
  readonly text: string
  readonly complete: boolean
}

const useStreamingText = (id: string | undefined, rows: ReadonlyArray<EventRow>): string => {
  const [streaming, setStreaming] = useState<StreamingText | undefined>()
  const terminal = rows.findLast(({ event }) =>
    ["TextReturned", "ToolCalled", "TurnCompleted", "TurnFailed"].includes(event.type))?.seq

  useEffect(() => {
    if (id === undefined) return
    setStreaming(undefined)
    return client.followInference(actor, id, {
      onDelta: (delta: InferDelta) => setStreaming((current) => {
        if (current?.physicalAttempt !== delta.physicalAttempt) {
          return {
            physicalAttempt: delta.physicalAttempt,
            nextSequence: delta.sequence + 1,
            text: delta.sequence === 0 ? delta.text : "",
            complete: delta.sequence !== 0
          }
        }
        if (current.complete) return current
        if (delta.sequence !== current.nextSequence) return { ...current, text: "", complete: true }
        return { ...current, nextSequence: delta.sequence + 1, text: current.text + delta.text }
      })
    })
  }, [id])

  useEffect(() => setStreaming(undefined), [terminal])
  return streaming?.text ?? ""
}

const latestMessageSeq = (rows: ReadonlyArray<EventRow>): number =>
  rows.findLast(({ event }) => event.type === "MessageReceived")?.seq ?? -1

const Transcript = ({ anchorAfterSeq, empty, onOpenThread, rows, streamingText }: {
  readonly anchorAfterSeq: number | undefined
  readonly empty: string
  readonly onOpenThread: (id: string) => void
  readonly rows: ReadonlyArray<EventRow>
  readonly streamingText: string
}): ReactElement => {
  const viewport = useRef<HTMLElement>(null)
  const messages = rows.filter(({ event }) =>
    event.type === "MessageReceived" || event.type === "ToolCalled" || event.type === "ChildCreated" ||
    (event.type === "PackageCalled" && !value(event, "name")?.startsWith("agents.")) ||
    event.type === "TurnCompleted" || event.type === "TurnFailed"
  )
  const toolsReturned = new Set(rows
    .filter(({ event }) => event.type === "ToolReturned")
    .map(({ event }) => value(event, "callId")))
  const packagesReturned = new Set(rows
    .filter(({ event }) => event.type === "PackageReturned")
    .map(({ event }) => value(event, "callId")))
  const responses = new Set(rows
    .filter(({ event }) => event.type === "ResponseReceived")
    .map(({ event }) => value(event, "call")))
  const isAgentResultCollector = (event: Event): boolean => {
    const id = value(event, "callId")
    if (event.type !== "ToolCalled" || id === undefined) return false
    const calls = rows.filter(({ event: row }) =>
      row.type === "PackageCalled" && value(row, "callId")?.startsWith(`${id}.`))
    return calls.length > 0 && calls.every(({ event: row }) => value(row, "name") === "agents.result")
  }
  const anchor = anchorAfterSeq === undefined ? undefined : messages.find(({ event, seq }) =>
    event.type === "MessageReceived" && seq > anchorAfterSeq)

  useLayoutEffect(() => {
    if (anchor === undefined) return
    viewport.current?.querySelector<HTMLElement>(`[data-message-seq="${anchor.seq}"]`)?.scrollIntoView({
      block: "start",
      behavior: "auto"
    })
  }, [anchor?.seq])

  return (
    <section className="messages" aria-live="polite" ref={viewport}>
      {messages.length === 0 ? <p className="empty">{empty}</p> : null}
      {messages.map(({ event, seq }, index) => {
        if (event.type === "ChildCreated") {
          if (messages[index - 1]?.event.type === "ChildCreated") return null
          const group: Array<EventRow> = []
          for (const row of messages.slice(index)) {
            if (row.event.type !== "ChildCreated") break
            group.push(row)
          }
          const pending = group.filter(({ event: child }) => {
            const id = childThread(child)
            return id !== undefined && !responses.has(id)
          }).length
          return (
            <details className="subagent-tree" key={seq}>
              <summary>
                <CaretRight className="tree-caret" />
                <Worm />
                <span>x{group.length} {group.length === 1 ? "subagent" : "subagents"}</span>
                {pending === 0 ? null : (
                  <>
                    <CircleNotch className="spin tree-spinner" aria-hidden="true" />
                    <span className="sr-only">{pending} still running</span>
                  </>
                )}
              </summary>
              <div className="tree-children">
                {group.map((child, childIndex) => {
                  const id = childThread(child.event)
                  return id === undefined ? null : (
                    <Button className="subagent-link" key={child.seq} onClick={() => onOpenThread(id)}>
                      <Worm />
                      Subagent {childIndex + 1}
                    </Button>
                  )
                })}
              </div>
            </details>
          )
        }
        if (event.type === "ToolCalled" || event.type === "PackageCalled") {
          if (isAgentResultCollector(event)) return null
          const complete = event.type === "ToolCalled"
            ? toolsReturned.has(value(event, "callId"))
            : packagesReturned.has(value(event, "callId"))
          const execute = value(event, "name") === "execute"
          return (
            <details className={`tool-call${event.type === "PackageCalled" ? " package-call" : ""}`} key={seq}>
              <summary>
                <CaretRight className="tool-caret" />
                {execute ? <Code /> : <PackageIcon />}
                <span>{toolTitle(event, complete)}</span>
                {complete ? null : <CircleNotch className="spin tool-spinner" />}
              </summary>
              <pre><code>{toolContent(event)}</code></pre>
            </details>
          )
        }
        return (
          <article
            className={event.type === "MessageReceived" ? "user" : event.type === "TurnFailed" ? "assistant failed" : "assistant"}
            data-message-seq={event.type === "MessageReceived" ? seq : undefined}
            key={seq}
          >
            {value(event, event.type === "MessageReceived" ? "text" : event.type === "TurnFailed" ? "error" : "output")}
          </article>
        )
      })}
      {streamingText.length > 0 ? (
        <article className="assistant streaming">{streamingText}</article>
      ) : waitingForResponse(rows) ? (
        <article className="assistant loading" aria-label="Assistant is responding">
          <span /><span /><span />
        </article>
      ) : null}
      {anchor === undefined ? null : <div className="turn-space" aria-hidden="true" />}
    </section>
  )
}

const Composer = ({ id, onSend, pending, placeholder }: {
  readonly id: string
  readonly onSend: (text: string) => void
  readonly pending: boolean
  readonly placeholder: string
}): ReactElement => {
  const [draft, setDraft] = useState("")

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const text = draft.trim()
    if (text.length === 0 || pending) return
    setDraft("")
    onSend(text)
  }

  return (
    <form className="composer" onSubmit={submit}>
      <label htmlFor={id}>Message</label>
      <Input
        id={id}
        placeholder={placeholder}
        value={draft}
        onValueChange={setDraft}
        autoComplete="off"
      />
      <Button type="submit" disabled={pending || draft.trim().length === 0} focusableWhenDisabled>
        {pending ? <CircleNotch className="spin" /> : <ArrowUp />}
        <span className="sr-only">Send message</span>
      </Button>
    </form>
  )
}

const Chat = (): ReactElement => {
  const cache = useQueryClient()
  const [selectedChild, setSelectedChild] = useState<string | undefined>(undefined)
  const [streamVersion, setStreamVersion] = useState(0)
  const [rootAnchorAfterSeq, setRootAnchorAfterSeq] = useState<number | undefined>()
  const [childAnchorAfterSeq, setChildAnchorAfterSeq] = useState<number | undefined>()
  const events = useQuery({ queryKey: eventsKey, queryFn: () => readEvents(thread) })
  const threads = useQuery({ queryKey: ["threads", actor], queryFn: () => client.list(actor) })
  const childEventsKey = ["events", actor, selectedChild] as const
  const childEvents = useQuery({
    queryKey: childEventsKey,
    queryFn: () => readEvents(selectedChild!),
    enabled: selectedChild !== undefined
  })
  const send = useMutation({
    mutationFn: (text: string) => client.call(actor, thread, "message", {
      id: crypto.randomUUID(),
      input: { text }
    }),
    onMutate: () => setRootAnchorAfterSeq(latestMessageSeq(
      cache.getQueryData<ReadonlyArray<EventRow>>(eventsKey) ?? []
    )),
    onSuccess: async () => {
      await events.refetch()
      await cache.invalidateQueries({ queryKey: ["threads", actor] })
      setStreamVersion((current) => current + 1)
    }
  })
  const sendChild = useMutation({
    mutationFn: ({ id, text }: { readonly id: string; readonly text: string }) =>
      client.call(actor, id, "message", {
        id: crypto.randomUUID(),
        input: { text }
      }),
    onMutate: ({ id }) => setChildAnchorAfterSeq(latestMessageSeq(
      cache.getQueryData<ReadonlyArray<EventRow>>(["events", actor, id]) ?? []
    )),
    onSuccess: async (_, { id }) => {
      await cache.invalidateQueries({ queryKey: ["events", actor, id] })
      await cache.invalidateQueries({ queryKey: ["threads", actor] })
    }
  })

  useEffect(() => {
    if (!events.isFetched) return
    const current = cache.getQueryData<ReadonlyArray<EventRow>>(eventsKey) ?? []
    if (current.length === 0) return
    return client.follow(actor, thread, {
      after: current.at(-1)?.seq,
      onEvent: (row) => cache.setQueryData<ReadonlyArray<EventRow>>(eventsKey, (held = []) => merge(held, row))
    })
  }, [cache, events.isFetched, streamVersion])

  useEffect(() => client.followThreads(actor, {
    onEvent: ({ event }) => {
      if (event.type === "ThreadAdded") void cache.invalidateQueries({ queryKey: ["threads", actor] })
    }
  }), [cache])

  useEffect(() => {
    if (selectedChild === undefined || !childEvents.isFetched) return
    const current = cache.getQueryData<ReadonlyArray<EventRow>>(childEventsKey) ?? []
    return client.follow(actor, selectedChild, {
      after: current.at(-1)?.seq,
      onEvent: (row) => cache.setQueryData<ReadonlyArray<EventRow>>(childEventsKey, (held = []) => merge(held, row))
    })
  }, [cache, childEvents.isFetched, selectedChild])

  const rows = events.data ?? []
  const streamedRoot = useStreamingText(thread, rows)
  const streamedChild = useStreamingText(selectedChild, childEvents.data ?? [])

  return (
    <div className="workspace">
    <aside className="thread-sidebar" aria-label="Threads">
      <header className="thread-sidebar-head">
        <strong>Threads</strong>
        <Button className="icon-button" onClick={startThread} aria-label="Start new thread" title="Start new thread">
          <Plus />
        </Button>
      </header>
      <nav className="thread-list">
        {(threads.data ?? []).filter((item) => item.parent === undefined).map((item) => (
          <Button
            className="thread-link"
            data-active={item.id === thread ? "" : undefined}
            key={item.id}
            onClick={() => openThread(item.id)}
            title={threadLabel(item.lastAt)}
          >
            <ChatCircle />
            <span>{threadLabel(item.lastAt)}</span>
          </Button>
        ))}
        {threads.isLoading ? <p className="thread-empty">Loading…</p> : null}
        {threads.data?.length === 0 ? <p className="thread-empty">No threads yet</p> : null}
        {threads.error ? <p className="thread-empty">Threads unavailable</p> : null}
      </nav>
    </aside>
    <main className="shell">
      <header className="root-head" />

      <Transcript
        anchorAfterSeq={rootAnchorAfterSeq}
        empty="Ask this agent about the files in its workspace."
        onOpenThread={setSelectedChild}
        rows={rows}
        streamingText={streamedRoot}
      />

      <Composer
        id="message"
        onSend={(text) => send.mutate(text)}
        pending={send.isPending}
        placeholder="Ask about the codebase"
      />

      {events.error || send.error ? <p className="error">{String(events.error ?? send.error)}</p> : null}
    </main>
    {selectedChild === undefined ? null : (
      <aside className="side-thread" aria-label="Subagent thread">
        <header className="side-head">
          <div>
            <strong>Subagent</strong>
            <span>{threads.data?.find((item) => item.id === selectedChild)?.status}</span>
          </div>
          <Button className="icon-button" onClick={() => setSelectedChild(undefined)} aria-label="Close subagent thread">
            <X />
          </Button>
        </header>
        <Transcript
          anchorAfterSeq={childAnchorAfterSeq}
          empty={childEvents.isLoading ? "Loading thread…" : "No messages in this thread."}
          onOpenThread={setSelectedChild}
          rows={childEvents.data ?? []}
          streamingText={streamedChild}
        />
        <Composer
          id="child-message"
          key={selectedChild}
          onSend={(text) => sendChild.mutate({ id: selectedChild, text })}
          pending={sendChild.isPending}
          placeholder="Message this subagent"
        />
        {childEvents.error || sendChild.error ? (
          <p className="error side-error">{String(childEvents.error ?? sendChild.error)}</p>
        ) : null}
      </aside>
    )}
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Chat />
    </QueryClientProvider>
  </StrictMode>
)
