import type { Event } from "@clavia/tardigrade-core/event"

export const MAX_SUBJECTS_PER_EVENT = 8
export const MAX_SUBJECTS_PER_LOOKUP = 8
export const MAX_SUBJECT_LENGTH = 512

/**
 * SubjectFragment derives stable read subjects for one event alphabet.
 *
 * A key names an occurrence. A subject names a fact, and a later event under the same subject supersedes the earlier event. One event may satisfy several subjects. Duplicate prefixes throw during composition.
 */
export interface SubjectFragment {
  readonly prefixes: ReadonlyArray<string>
  readonly subjectsOf: (event: Event) => ReadonlyArray<string>
}

export const assertSubject = (subject: string): void => {
  if (subject.length === 0 || subject.length > MAX_SUBJECT_LENGTH) {
    throw new Error(`subjects must contain between 1 and ${MAX_SUBJECT_LENGTH} characters`)
  }
}

export const assertEventSubjects = (subjects: ReadonlyArray<string>): void => {
  if (subjects.length > MAX_SUBJECTS_PER_EVENT) {
    throw new Error(`an event may name at most ${MAX_SUBJECTS_PER_EVENT} subjects`)
  }
  for (const subject of subjects) assertSubject(subject)
}

export const assertSubjectLookup = (subjects: ReadonlyArray<string>): void => {
  if (subjects.length === 0 || subjects.length > MAX_SUBJECTS_PER_LOOKUP) {
    throw new Error(`a fact lookup requires between 1 and ${MAX_SUBJECTS_PER_LOOKUP} subjects`)
  }
  for (const subject of subjects) assertSubject(subject)
}

// composeSubjects combines disjoint subject fragments into one bounded read-subject derivation. Duplicate prefixes throw during construction.
export const composeSubjects = (...fragments: ReadonlyArray<SubjectFragment>): ((event: Event) => ReadonlyArray<string>) => {
  const claimed = new Map<string, number>()
  fragments.forEach((fragment, index) => {
    for (const prefix of fragment.prefixes) {
      const prior = claimed.get(prefix)
      if (prior !== undefined) {
        throw new Error(`subject prefix "${prefix}" claimed by fragments ${prior} and ${index}`)
      }
      claimed.set(prefix, index)
    }
  })
  return (event) => {
    const subjects: string[] = []
    const seen = new Set<string>()
    for (const fragment of fragments) {
      for (const subject of fragment.subjectsOf(event)) {
        if (seen.has(subject)) continue
        seen.add(subject)
        subjects.push(subject)
      }
    }
    assertEventSubjects(subjects)
    return subjects
  }
}
