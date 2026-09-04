import { Button } from "@base-ui/react/button"
import { ArrowLeft, CircleNotch, X } from "@phosphor-icons/react"
import type { ReactElement } from "react"
import type { EventRow, ThreadSummary } from "@clavia/tardigrade-client"

import { Composer } from "./Composer"
import { Transcript } from "./Transcript"

export const SideThread = ({ error, loading, onClose, onOpenThread, onSend, pending, rows, selected, streamingText, threads }: {
  readonly error: unknown
  readonly loading: boolean
  readonly onClose: () => void
  readonly onOpenThread: (id: string) => void
  readonly onSend: (text: string) => void
  readonly pending: boolean
  readonly rows: ReadonlyArray<EventRow>
  readonly selected: string
  readonly streamingText: string
  readonly threads: ReadonlyArray<ThreadSummary>
}): ReactElement => {
  const status = threads.find((item) => item.id === selected)?.status

  return <aside className="side-thread" aria-label="Subagent thread">
    <header className="side-head">
      <Button className="icon-button side-back-button" onClick={onClose} aria-label="Back to parent thread">
        <ArrowLeft />
      </Button>
      <div>
        <strong>Subagent</strong>
        {status === "running" ? (
          <CircleNotch className="spin side-status-spinner" aria-label="Subagent is running" />
        ) : status === "failed" || status === "blocked" ? <span>{status}</span> : null}
      </div>
      <Button className="icon-button side-close-button" onClick={onClose} aria-label="Close subagent thread">
        <X />
      </Button>
    </header>
    <Transcript
      empty={loading ? "Loading thread…" : "No messages in this thread."}
      onOpenThread={onOpenThread}
      rows={rows}
      streamingText={streamingText}
    />
    <Composer id="child-message" onSend={onSend} pending={pending} placeholder="Message this subagent" />
    {error ? <p className="error side-error">{String(error)}</p> : null}
  </aside>
}
