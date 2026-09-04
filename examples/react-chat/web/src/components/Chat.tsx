import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState, type ReactElement } from "react"
import type { EventRow } from "@clavia/tardigrade-client"

import { actor, client } from "../chat-client"
import { mergeEvents, readEvents } from "../events"
import { useStreamingText } from "../use-streaming-text"
import { Composer } from "./Composer"
import { SideThread } from "./SideThread"
import { ThreadSidebar } from "./ThreadSidebar"
import { Transcript } from "./Transcript"

const THREAD_KEY = "tardigrade.chat.thread"
const thread = localStorage.getItem(THREAD_KEY) ?? crypto.randomUUID()
localStorage.setItem(THREAD_KEY, thread)

const eventsKey = ["events", actor, thread] as const

const openThread = (id: string) => {
  localStorage.setItem(THREAD_KEY, id)
  location.reload()
}

const startThread = () => openThread(crypto.randomUUID())

export const Chat = (): ReactElement => {
  const cache = useQueryClient()
  const [selectedChild, setSelectedChild] = useState<string | undefined>(undefined)
  const [streamVersion, setStreamVersion] = useState(0)
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
    onSuccess: async () => {
      await events.refetch()
      await cache.invalidateQueries({ queryKey: ["threads", actor] })
      setStreamVersion((current) => current + 1)
    }
  })
  const sendChild = useMutation({
    mutationFn: ({ id, text }: { readonly id: string; readonly text: string }) =>
      client.call(actor, id, "message", { id: crypto.randomUUID(), input: { text } }),
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
      onEvent: (row) => cache.setQueryData<ReadonlyArray<EventRow>>(eventsKey, (held = []) => mergeEvents(held, row))
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
      onEvent: (row) => cache.setQueryData<ReadonlyArray<EventRow>>(childEventsKey, (held = []) => mergeEvents(held, row))
    })
  }, [cache, childEvents.isFetched, selectedChild])

  const rows = events.data ?? []
  const streamedRoot = useStreamingText(thread, rows)
  const streamedChild = useStreamingText(selectedChild, childEvents.data ?? [])

  return (
    <div className="workspace" data-child-open={selectedChild === undefined ? undefined : ""}>
      <ThreadSidebar
        active={thread}
        error={threads.error}
        loading={threads.isLoading}
        onOpen={openThread}
        onStart={startThread}
        threads={threads.data ?? []}
      />
      <main className="shell">
        <header className="root-head"><strong>RLM chat</strong></header>
        <Transcript
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
        <SideThread
          error={childEvents.error ?? sendChild.error}
          key={selectedChild}
          loading={childEvents.isLoading}
          onClose={() => setSelectedChild(undefined)}
          onOpenThread={setSelectedChild}
          onSend={(text) => sendChild.mutate({ id: selectedChild, text })}
          pending={sendChild.isPending}
          rows={childEvents.data ?? []}
          selected={selectedChild}
          streamingText={streamedChild}
          threads={threads.data ?? []}
        />
      )}
    </div>
  )
}
