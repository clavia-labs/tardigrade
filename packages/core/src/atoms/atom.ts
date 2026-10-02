import { Effect, Layer } from "effect"
import { AsyncResult, Atom as NativeAtom } from "effect/unstable/reactivity"

export type Atom<Value> = NativeAtom.Atom<Value>
export type Getter = <Value>(node: Atom<Value>) => Value
export type SetStateAction<Value> = Value | ((previous: Value) => Value)
export type PrimitiveAtom<Value> = NativeAtom.Writable<Value, SetStateAction<Value>>

const runtimeFactory = NativeAtom.context({
  memoMap: NativeAtom.readable(() => Layer.makeMemoMapUnsafe()).pipe(NativeAtom.keepAlive, NativeAtom.withLabel("service cache")),
})

// atom creates pure derived values or writable source values retained for the store lifetime.
export function atom<Value>(read: (get: Getter) => Value): Atom<Value>
export function atom<Value>(initial: Value): PrimitiveAtom<Value>
export function atom<Value>(value: Value | ((get: Getter) => Value)): Atom<Value> | PrimitiveAtom<Value> {
  if (typeof value === "function") {
    return NativeAtom.readable(value as (get: Getter) => Value).pipe(NativeAtom.keepAlive)
  }
  const node: PrimitiveAtom<Value> = NativeAtom.writable(
    () => value,
    (context, update: SetStateAction<Value>) => context.setSelf(
      typeof update === "function" ? (update as (previous: Value) => Value)(context.get(node)) : update,
    ),
  ).pipe(NativeAtom.keepAlive)
  return node
}

// runtimeAtom carries projection requirements to actor setup and unwraps synchronous native results for replay.
export function runtimeAtom<Value, Failure, Services>(read: (get: NativeAtom.AtomContext) => Effect.Effect<Value, Failure, Services>, options: { readonly name?: string } = {}): Effect.Effect<Atom<Value>, never, Services> {
  return Effect.map(Effect.context<Services>(), services => {
    const runtime = runtimeFactory(Layer.succeedContext(services))
    Object.assign(runtime.layer, { label: NativeAtom.withLabel(runtime.layer, options.name ? `${options.name} services` : "service layer").label })
    const output = runtime.atom(read)
    return atom(get => {
      const result = get(output)
      if (result.waiting || AsyncResult.isInitial(result)) throw new Error("Actor projections must resolve synchronously; return asynchronous work as an effect value")
      return AsyncResult.getOrThrow(result)
    })
  })
}
