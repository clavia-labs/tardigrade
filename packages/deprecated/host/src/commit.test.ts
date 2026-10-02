import { expect, test } from "bun:test"
import { Effect } from "effect"
import { CommitDispatcher } from "./commit"

const commit = (head: number) => ({ actor: "agent", instance: "user", thread: "root", head })

test("a slow commit observer receives the latest pending head", async () => {
  const seen: Array<number> = []
  let release = () => {}
  let started = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const active = new Promise<void>((resolve) => { started = resolve })
  const dispatcher = new CommitDispatcher({
    onCommit: ({ head }) => Effect.promise(async () => {
      seen.push(head)
      if (head === 1) {
        started()
        await gate
      }
    })
  })

  dispatcher.offer(commit(1))
  await active
  dispatcher.offer(commit(2))
  dispatcher.offer(commit(3))
  release()
  await dispatcher.close()

  expect(seen).toEqual([1, 3])
})

test("commit observer failure and timeout do not escape delivery", async () => {
  const failed = new CommitDispatcher({ onCommit: () => Effect.die("offline") })
  const timedOut = new CommitDispatcher({
    onCommit: () => Effect.never,
    policy: { deliveryTimeoutMs: 1 }
  })

  failed.offer(commit(1))
  timedOut.offer(commit(1))
  await Promise.all([failed.close(), timedOut.close()])
})
