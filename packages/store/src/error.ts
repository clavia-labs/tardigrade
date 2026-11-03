import { Data } from "effect"
import type { ObjectRef } from "./reference"

// ObjectStorageError distinguishes unavailable objects, integrity failures, and backend failures.
export class ObjectStorageError extends Data.TaggedError("ObjectStorageError")<{
  readonly reason: "Unavailable" | "Missing" | "Integrity" | "Read" | "Write" | "TooLarge"
  // reference may be absent before a streaming digest is available.
  readonly reference?: ObjectRef
  readonly message: string
  readonly cause?: unknown
  readonly maxObjectBytes?: number
  readonly actualBytes?: number
}> {}
