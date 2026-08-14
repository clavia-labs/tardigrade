import { Effect } from "effect"

// A capability is one named object a script can reach, and it is the extension point of this
// package. A harness developer decides what the model can do by choosing the list, so the sandbox
// surface is application vocabulary rather than framework vocabulary.
//
// A method declares its call shape as a signature string. The signature is what the model reads, so
// it is written for a reader of code rather than for a schema validator: the sandbox already
// rejects a bad call at the call site, and the error returns to the model as an ordinary failure.

export interface CapabilityMethod<R = never> {
  readonly name: string
  // How the call reads in source, such as `call(address, text): Promise<Result>`.
  readonly signature: string
  readonly description: string
  readonly run: (
    args: ReadonlyArray<unknown>,
    context: CapabilityContext
  ) => Effect.Effect<unknown, never, R>
}

// What the running script belongs to. A capability that mints ids derives them from `execId` and
// its own call index, so a re-run of the same script asks the same questions and a receiver that
// dedups absorbs the repeat.
export interface CapabilityContext {
  readonly turn: string
  readonly execId: string
  readonly sequence: number
}

export interface Capability<R = never> {
  readonly name: string
  readonly summary: string
  readonly methods: ReadonlyArray<CapabilityMethod<R>>
}

export const capability = <R = never>(value: Capability<R>): Capability<R> => {
  const names = new Set<string>()
  for (const method of value.methods) {
    if (names.has(method.name)) {
      throw new Error(`capability "${value.name}" declares "${method.name}" more than once`)
    }
    names.add(method.name)
  }
  return value
}

// The surface as the model reads it. Names and signatures are cheap, so they sit in the static
// instruction where they cache; a capability that needs more explanation carries it in its
// description and its method descriptions.
export const surfaceOf = (capabilities: ReadonlyArray<Capability<any>>): string =>
  capabilities
    .map((one) =>
      [
        `${one.name}: ${one.summary}`,
        ...one.methods.map((method) => `  ${one.name}.${method.signature}  ${method.description}`)
      ].join("\n")
    )
    .join("\n")
