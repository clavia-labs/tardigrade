import { Button } from "@base-ui/react/button"
import { ChatCircle, Plus } from "@phosphor-icons/react"
import type { ReactElement } from "react"
import type { ThreadSummary } from "@clavia/tardigrade-client"

const threadLabel = (lastAt: number | undefined): string => lastAt === undefined
  ? "New thread"
  : new Date(lastAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

export const ThreadSidebar = ({ active, error, loading, onOpen, onStart, threads }: {
  readonly active: string
  readonly error: unknown
  readonly loading: boolean
  readonly onOpen: (id: string) => void
  readonly onStart: () => void
  readonly threads: ReadonlyArray<ThreadSummary>
}): ReactElement => (
  <aside className="thread-sidebar" aria-label="Threads">
    <header className="thread-sidebar-head">
      <strong>Threads</strong>
      <Button className="icon-button" onClick={onStart} aria-label="Start new thread" title="Start new thread">
        <Plus />
      </Button>
    </header>
    <nav className="thread-list">
      {threads.filter((item) => item.parent === undefined).map((item) => (
        <Button
          className="thread-link"
          data-active={item.id === active ? "" : undefined}
          key={item.id}
          onClick={() => onOpen(item.id)}
          title={threadLabel(item.lastAt)}
        >
          <ChatCircle />
          <span>{threadLabel(item.lastAt)}</span>
        </Button>
      ))}
      {loading ? <p className="thread-empty">Loading…</p> : null}
      {threads.length === 0 && !loading ? <p className="thread-empty">No threads yet</p> : null}
      {error ? <p className="thread-empty">Threads unavailable</p> : null}
    </nav>
  </aside>
)
