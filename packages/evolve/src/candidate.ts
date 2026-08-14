export interface Candidate<Value> {
  readonly id: string
  readonly value: Value
  readonly parent?: string
  readonly source?: string
}

export interface CandidateOptions {
  readonly parent?: string
  readonly source?: string
}

export const candidate = <Value>(
  id: string,
  value: Value,
  options: CandidateOptions = {}
): Candidate<Value> => ({
  id,
  value,
  ...(options.parent === undefined ? {} : { parent: options.parent }),
  ...(options.source === undefined ? {} : { source: options.source })
})
