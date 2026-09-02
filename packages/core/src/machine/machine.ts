// Machine defines a stateful computation from inputs to observable outputs.
export interface Machine<Input, State, Output> {
  readonly initial: () => State
  readonly step: (state: State, input: Input) => State
  readonly output: (state: State) => Output
}
