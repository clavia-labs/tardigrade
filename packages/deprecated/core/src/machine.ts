/**
 * Machine is the smallest stateful computational unit in Tardigrade.
 * It is a Moore-style state machine with a potentially infinite state space.
 * See Event for the smallest data primitive.
 *
 *   Machine<Input, State, Output>
 *           │        │       │
 *           │        │       └─ what observers see
 *           │        └───────── what the machine remembers
 *           └────────────────── what enters the machine
 */
export interface Machine<Input, State, Output> {
  readonly initial: () => State
  readonly step: (state: State, input: Input) => State
  readonly output: (state: State) => Output
}
