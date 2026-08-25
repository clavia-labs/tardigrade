// ActorMethodCall identifies one durable invocation and carries its decoded input.
export interface ActorMethodCall<Input> {
  readonly id: string
  readonly input: Input
  readonly at: number
}

// ActorMethodInvocation identifies the declared method and call carried by an envelope.
export interface ActorMethodInvocation {
  readonly method: string
  readonly id: string
}
