// effectInput defines storage and observer contracts over the effectIdentity coordinate.
// Inputs and acts are finite symbols; digest equality is assumed to identify equal canonical inputs.
// Hash implementation, JSON encoding, byte costs, and TypeScript refinement are outside this model.
module effectInput {
  import effectIdentity as identity from "./effectIdentity"

  type Proposal = { act: str, input: int }
  type Stored = { ref: identity::Ref, act: str, digest: int, inline: Set[int] }
  type Acceptance = { ref: identity::Ref, act: str }

  pure val proposals = tuples(Set("call", "other"), Set(0, 1)).map(pair => { act: pair._1, input: pair._2 })
  pure def digest(input: int): int = input
  pure val operationKeys = identity::operationKeys
  pure def reference(position: int, key: (str, str)): identity::Ref = identity::reference(position, key)
  pure def original(position: int): Proposal = { act: if (position % 2 == 0) "call" else "other", input: (position / 2) % 2 }

  // encode preserves identity and act while permitting either input storage representation.
  pure def encode(ref: identity::Ref, proposal: Proposal, inline: bool): Stored = {
    ref: ref, act: proposal.act, digest: digest(proposal.input),
    inline: if (inline) Set(proposal.input) else Set(),
  }
  // observe exposes acceptance independently of the execution payload and its representation.
  pure def observe(request: Stored): Acceptance = { ref: request.ref, act: request.act }
  // matches validates a reconstructed proposal before runtime execution or cleanup.
  pure def matches(request: Stored, proposal: Proposal): bool =
    request.act == proposal.act and request.digest == digest(proposal.input)
      and (request.inline == Set() or request.inline == Set(proposal.input))
}
