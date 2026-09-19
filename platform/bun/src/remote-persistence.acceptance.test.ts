import { describe, test } from "bun:test"

describe("authoritative remote persistence for local Bun hosts", () => {
  test.todo(
    "Given a local actor has acknowledged unfinished progress in remote state. " +
    "When its process stops without shutdown hooks and its local directory is deleted, " +
    "then a fresh local host with the same identity resumes from the acknowledged progress.",
    () => {}
  )

  test.todo(
    "Given a completed invocation, result, and history are acknowledged in remote state. " +
    "When a fresh local host retries the same invocation, " +
    "then it returns the retained result without running completed actor steps again.",
    () => {}
  )

  test.todo(
    "Given a parent has pending child work plus retained workspace and object values. " +
    "When local disk is lost, then recovery preserves the pending child identity " +
    "and makes each retained value available.",
    () => {}
  )

  test.todo(
    "Given remote storage is unavailable or rejects a commit. " +
    "When a local host records progress, then it reports no durable success and creates no ephemeral fallback. " +
    "Later recovery starts at the last acknowledged progress.",
    () => {}
  )

  test.todo(
    "Given two local hosts use the same durable actor identity. " +
    "When both hosts record conflicting progress, then at most one host acknowledges its progress. " +
    "Recovery reads the acknowledged history.",
    () => {}
  )

  test.todo(
    "Given local actor code records progress through remote persistence. " +
    "When two durable identities run, then each actor executes in its caller's Bun process " +
    "and each identity recovers its own history and retained values.",
    () => {}
  )
})
