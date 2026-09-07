import { Schema } from "effect"

// ACTOR_INSTANCE_ID_PATTERN accepts a non-empty opaque identifier.
export const ACTOR_INSTANCE_ID_PATTERN = /^[\s\S]+$/u

export const ActorInstanceId = Schema.String.pipe(
  Schema.check(Schema.makeFilter((value: string) => ACTOR_INSTANCE_ID_PATTERN.test(value), {
    title: `actor instance id matching ${String(ACTOR_INSTANCE_ID_PATTERN)}`,
    toJsonSchema: () => ({ pattern: ACTOR_INSTANCE_ID_PATTERN.source })
  }))
).annotate({ identifier: "ActorInstanceId" })

export type ActorInstanceId = typeof ActorInstanceId.Type

// isActorInstanceId reports whether a value is a valid actor instance identifier.
export const isActorInstanceId = (value: unknown): value is ActorInstanceId => Schema.is(ActorInstanceId)(value)

// ActorCoordinate locates an instance of an actor.
export const ActorCoordinate = Schema.Struct({
  actor: Schema.String,
  instance: ActorInstanceId
})

export type ActorCoordinate = typeof ActorCoordinate.Type

// actorCoordinateOf composes an actor definition and its locally scoped instance ref.
export const actorCoordinateOf = (actor: string, instance: string): ActorCoordinate =>
  Schema.decodeSync(ActorCoordinate)({ actor, instance })

// ThreadCoordinate extends an actor coordinate with a thread identifier.
export const ThreadCoordinate = Schema.Struct({
  ...ActorCoordinate.fields,
  thread: Schema.String
}).annotate({ identifier: "ThreadCoordinate" })

export type ThreadCoordinate = typeof ThreadCoordinate.Type

// threadCoordinateOf extends an actor coordinate with a locally scoped thread ref.
export const threadCoordinateOf = (actor: ActorCoordinate, thread: string): ThreadCoordinate =>
  Schema.decodeSync(ThreadCoordinate)({ ...actor, thread })

const CoordinateSegment = Schema.NonEmptyString.pipe(
  Schema.check(Schema.makeFilter((value: string) => !value.includes("/"), {
    title: "coordinate segment without /"
  }))
)

const ReadableThreadCoordinate = Schema.Struct({
  actor: CoordinateSegment,
  instance: CoordinateSegment,
  thread: CoordinateSegment
})

// formatThreadCoordinate formats three nonempty, slash-free segments as actor/instance/thread (coordinate.test.ts).
export const formatThreadCoordinate = (coordinate: ThreadCoordinate): string => {
  const { actor, instance, thread } = Schema.decodeSync(ReadableThreadCoordinate)(coordinate)
  return `${actor}/${instance}/${thread}`
}

// parseThreadCoordinate validates actor/instance/thread without trimming or decoding its segments (coordinate.test.ts).
export const parseThreadCoordinate = (text: string): ThreadCoordinate => {
  const segments = Schema.decodeSync(Schema.String)(text).split("/")
  if (segments.length !== 3) throw new Error("thread coordinate must contain exactly three segments: actor/instance/thread")
  const [actor, instance, thread] = segments
  return Schema.decodeUnknownSync(ReadableThreadCoordinate)({ actor, instance, thread })
}

// ChildKey identifies a child within its parent's thread namespace.
export const ChildKey = Schema.NonEmptyString.pipe(Schema.brand("ChildKey"))
export type ChildKey = typeof ChildKey.Type

// ThreadId identifies a thread within an actor instance.
export const ThreadId = Schema.NonEmptyString.pipe(Schema.brand("ThreadId"))
export type ThreadId = typeof ThreadId.Type

// childKeyOf validates a creator-supplied child key.
export const childKeyOf = Schema.decodeUnknownSync(ChildKey)

// threadIdOf validates a caller-supplied thread identifier.
export const threadIdOf = Schema.decodeUnknownSync(ThreadId)
