import { useEffect, useState, type ReactElement } from "react"

import { Thread } from "./Thread"
import { type ActorMetadata, type ActorThread, type ProblemError } from "@clavia/tardigrade-client"

import { actorInstance, client } from "./client"
import { navigate, useRoute } from "./nav"
import { Quickstart } from "./Quickstart"
import { Rail } from "./Rail"
import { latestRootOf, listOf } from "./list"
import { applyActorEvent } from "./threads"

// The app: one screen, two panes. The rail lists the run's roots and the center pane reads the
// selected thread's log (mock.html). The reader chooses on the left and reads on the right, and
// there is nowhere else to go: voyager reads a run and never writes to it.

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

// useThreads follows the actor's thread identities and lineage once for the whole screen.
const useThreads = () => {
  const [threads, setThreads] = useState<ReadonlyArray<ActorThread>>([])
  const [problem, setProblem] = useState<ProblemError | undefined>(undefined)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    setThreads([])
    setProblem(undefined)
    setReady(false)
    let live = true
    const unsubscribe = client.followThreads(actorInstance(), {
      onEvent: ({ event }) => {
        if (!live) return
        setThreads((current) => applyActorEvent(current, event))
        setProblem(undefined)
        setReady(true)
      },
      onError: (error) => {
        if (!live) return
        setProblem(error)
        setReady(true)
      }
    })
    return () => {
      live = false
      unsubscribe()
    }
  }, [])

  return { threads, problem, ready }
}

export const App = (): ReactElement => {
  const route = useRoute()
  const actorMetadata = useActorMetadata()
  const { problem, threads, ready } = useThreads()
  const list = listOf(threads)
  useEffect(() => {
    if (!ready || route.view !== undefined || route.thread !== undefined) return
    const latest = latestRootOf(listOf(threads))
    if (latest === undefined) return
    navigate({ thread: latest.id, from: undefined, to: undefined }, { replace: true })
  }, [threads, ready, route.thread, route.view])
  return (
    <div style={{ height: "100%", display: "flex", overflow: "hidden", position: "relative" }}>
      <Rail list={list} problem={problem} selected={route.thread} />
      <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {route.view === "new" ? (
          <Quickstart actorMetadata={actorMetadata} />
        ) : route.thread === undefined && ready && threads.length === 0 && problem === undefined ? (
          <Quickstart actorMetadata={actorMetadata} />
        ) : route.thread === undefined ? (
          <div className="mono pane-empty">{ready ? "select a thread" : "loading threads"}</div>
        ) : (
          <Thread id={route.thread} />
        )}
      </main>
    </div>
  )
}
