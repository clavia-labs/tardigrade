import { useEffect, useState, type ReactElement } from "react"

import { Thread } from "./Thread"
import { NO_ANSWER, ProblemError, type ActorMetadata, type ThreadSummary } from "@clavia/tardigrade-client"

import { actorInstance, client } from "./client"
import { navigate, useRoute } from "./nav"
import { ROSTER_POLL_MS } from "./policy"
import { Quickstart } from "./Quickstart"
import { Rail } from "./Rail"
import { EMPTY_ROSTER, latestRootOf, rosterOf, type Roster } from "./roster"

// The app: one screen, two panes. The rail lists the run's roots and the center pane reads the
// selected thread's log (mock.html). The reader chooses on the left and reads on the right, and
// there is nowhere else to go: voyager reads a run and never writes to it.

interface Reading {
  readonly roster: Roster
  // When the listing was read, so every age on screen is measured from one instant.
  readonly at: number
}

const useActorMetadata = (): ActorMetadata | undefined => {
  const [metadata, setMetadata] = useState<ActorMetadata | undefined>(undefined)
  useEffect(() => {
    let live = true
    void client.metadata().then((found) => {
      if (live) setMetadata(found)
    }).catch(() => undefined)
    return () => { live = false }
  }, [])
  return metadata
}

// useRoster polls the current project's thread listing once for the whole screen. The rail's rows and the header's status chip share that reading, and the last good reading survives a server restart.
const useRoster = (intervalMs: number) => {
  const [reading, setReading] = useState<Reading>({ roster: EMPTY_ROSTER, at: Date.now() })
  const [summaries, setSummaries] = useState<ReadonlyArray<ThreadSummary>>([])
  const [problem, setProblem] = useState<ProblemError | undefined>(undefined)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    setSummaries([])
    setReading({ roster: EMPTY_ROSTER, at: Date.now() })
    setProblem(undefined)
    setReady(false)
    let live = true
    const read = async () => {
      try {
        const all = await client.list(actorInstance())
        if (!live) return
        setSummaries(all)
        setReading({ roster: rosterOf(all), at: Date.now() })
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
  }, [intervalMs])

  return { reading, summaries, problem, ready }
}

export const App = (): ReactElement => {
  const route = useRoute()
  const actorMetadata = useActorMetadata()
  const { problem, reading, summaries, ready } = useRoster(ROSTER_POLL_MS)
  const status = summaries.find((summary) => summary.id === route.thread)?.status
  useEffect(() => {
    if (!ready || route.view !== undefined || route.thread !== undefined) return
    const latest = latestRootOf(reading.roster)
    if (latest === undefined) return
    navigate({ thread: latest.id, from: undefined, to: undefined }, { replace: true })
  }, [reading.roster, ready, route.thread, route.view])
  return (
    <div style={{ height: "100%", display: "flex", overflow: "hidden", position: "relative" }}>
      <Rail roster={reading.roster} now={reading.at} problem={problem} selected={route.thread} />
      <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {route.view === "new" ? (
          <Quickstart actorMetadata={actorMetadata} />
        ) : route.thread === undefined && ready && summaries.length === 0 && problem === undefined ? (
          <Quickstart actorMetadata={actorMetadata} />
        ) : route.thread === undefined ? (
          <div className="mono pane-empty">{ready ? "select a thread" : "loading threads"}</div>
        ) : (
          <Thread id={route.thread} status={status} />
        )}
      </main>
    </div>
  )
}
