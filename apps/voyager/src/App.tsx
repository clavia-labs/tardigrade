import { useEffect, useState, type ReactElement } from "react"

import { Thread } from "./Thread"
import { NO_ANSWER, ProblemError, type ThreadSummary } from "@clavia/tardigrade-client"

import { client } from "./client"
import { useRoute } from "./nav"
import { ROSTER_POLL_MS } from "./policy"
import { Rail } from "./Rail"
import { EMPTY_ROSTER, rosterOf, type Roster } from "./roster"

// The app: one screen, two panes. The rail lists the run's roots and the center pane reads the
// selected thread's log (mock.html). The reader chooses on the left and reads on the right, and
// there is nowhere else to go: voyager reads a run and never writes to it.

interface Reading {
  readonly roster: Roster
  // When the listing was read, so every age on screen is measured from one instant.
  readonly at: number
}

// useRoster polls GET /v1/actors/:actor/threads once for the whole screen: the rail's rows and the header's status
// chip are the same listing read twice rather than two calls. The last good reading survives a
// failure, so a server restart holds the rail rather than blanking it.
const useRoster = (intervalMs: number) => {
  const [reading, setReading] = useState<Reading>({ roster: EMPTY_ROSTER, at: Date.now() })
  const [summaries, setSummaries] = useState<ReadonlyArray<ThreadSummary>>([])
  const [problem, setProblem] = useState<ProblemError | undefined>(undefined)

  useEffect(() => {
    let live = true
    const read = async () => {
      try {
        const all = await client.list()
        if (!live) return
        setSummaries(all)
        setReading({ roster: rosterOf(all), at: Date.now() })
        setProblem(undefined)
      } catch (error) {
        if (!live) return
        setProblem(error instanceof ProblemError ? error : new ProblemError({ title: String(error), status: NO_ANSWER }))
      }
    }
    void read()
    const timer = setInterval(read, intervalMs)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [intervalMs])

  return { reading, summaries, problem }
}

export const App = (): ReactElement => {
  const route = useRoute()
  const { problem, reading, summaries } = useRoster(ROSTER_POLL_MS)
  const status = summaries.find((summary) => summary.id === route.thread)?.status
  return (
    <div style={{ height: "100%", display: "flex", overflow: "hidden" }}>
      <Rail roster={reading.roster} now={reading.at} problem={problem} selected={route.thread} />
      <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {route.thread === undefined ? (
          <div className="mono pane-empty">select a run</div>
        ) : (
          <Thread id={route.thread} status={status} />
        )}
      </main>
    </div>
  )
}
