import { useEffect, useState, type ReactElement } from "react"

import { Thread } from "./Thread"
import { ApiSurface } from "./ApiSurface"
import { NO_ANSWER, ProblemError, RESERVED_ACTOR, type ThreadSummary } from "@clavia/tardigrade-client"

import { clientFor } from "./client"
import { navigate, useRoute } from "./nav"
import { ROSTER_POLL_MS } from "./policy"
import { Quickstart } from "./Quickstart"
import { Rail } from "./Rail"
import { EMPTY_ROSTER, latestRootOf, rosterOf, type Roster } from "./roster"

// The app: one screen, two panes. The rail lists the run's roots and the center pane reads the
// selected thread's log (mock.html). The reader chooses on the left and reads on the right, and
// there is nowhere else to go: voyager reads a run and never writes to it.

interface Reading {
  readonly actor: string | undefined
  readonly roster: Roster
  // When the listing was read, so every age on screen is measured from one instant.
  readonly at: number
}

// useRoster polls GET /v1/actors/:actor/threads once for the whole screen: the rail's rows and the header's status
// chip are the same listing read twice rather than two calls. The last good reading survives a
// failure, so a server restart holds the rail rather than blanking it.
const useRoster = (actor: string | undefined, intervalMs: number) => {
  const [reading, setReading] = useState<Reading>({ actor: undefined, roster: EMPTY_ROSTER, at: Date.now() })
  const [summaries, setSummaries] = useState<ReadonlyArray<ThreadSummary>>([])
  const [problem, setProblem] = useState<ProblemError | undefined>(undefined)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    setSummaries([])
    setReading({ actor, roster: EMPTY_ROSTER, at: Date.now() })
    setProblem(undefined)
    setReady(false)
    if (actor === undefined) return
    let live = true
    const selected = clientFor(actor)
    const read = async () => {
      try {
        const all = await selected.list()
        if (!live) return
        setSummaries(all)
        setReading({ actor, roster: rosterOf(all), at: Date.now() })
        setProblem(undefined)
        setReady(true)
      } catch (error) {
        if (!live) return
        setProblem(error instanceof ProblemError ? error : new ProblemError({ title: String(error), status: NO_ANSWER }))
        setReady(true)
      }
    }
    void read()
    const timer = setInterval(read, intervalMs)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [actor, intervalMs])

  return { reading, summaries, problem, ready }
}

export const App = (): ReactElement => {
  const route = useRoute()
  const actor = route.actor ?? RESERVED_ACTOR
  const { problem, reading, summaries, ready } = useRoster(actor, ROSTER_POLL_MS)
  const status = summaries.find((summary) => summary.id === route.thread)?.status
  useEffect(() => {
    if (!ready || reading.actor !== actor || route.view !== undefined || route.thread !== undefined) return
    const latest = latestRootOf(reading.roster)
    if (latest === undefined) return
    navigate({ thread: latest.id, from: undefined, to: undefined }, { replace: true })
  }, [actor, reading.actor, reading.roster, ready, route.thread, route.view])
  if (route.view === "api") return <ApiSurface />
  return (
    <div style={{ height: "100%", display: "flex", overflow: "hidden", position: "relative" }}>
      <Rail roster={reading.roster} now={reading.at} problem={problem} selected={route.thread} />
      <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {route.thread === undefined && ready && summaries.length === 0 && problem === undefined ? (
          <Quickstart />
        ) : route.thread === undefined ? (
          <div className="mono pane-empty">{ready ? "select a thread" : "loading threads"}</div>
        ) : (
          <Thread actor={actor} id={route.thread} status={status} />
        )}
      </main>
    </div>
  )
}
