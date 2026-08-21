// Link directs communication from a source address to a target address independently of placement and transport.
export interface Link<Source, Target> {
  readonly source: Source
  readonly target: Target
}

// linkOf constructs a directed link between two address spaces.
export const linkOf = <Source, Target>(source: Source, target: Target): Link<Source, Target> => ({
  source,
  target
})

// reverseLink exchanges a link's endpoints. Reversing twice preserves the original link (link.test.ts).
export const reverseLink = <Source, Target>(link: Link<Source, Target>): Link<Target, Source> => ({
  source: link.target,
  target: link.source
})
