# Supplied interactions

A receiver supplies an `interactionScope` through a component's `supplies` field. Its typed constructors return `InteractionRequest` descriptions. A source component binds one with `context.interaction(tag, request)`. The capability's scope selects the receiver's event constructor; the recorded source event, source component name, and tag select the durable transition identity. Identity wrappers inherit scopes without changing those coordinates.

## Obligations

| Property | Meaning | Enforcement |
| --- | --- | --- |
| `DescriptionIsPure` | Description and binding publish no work or events. | Request constructors allocate descriptions; event constructors run during intent materialization. User callbacks must remain pure. |
| `ReceiverIsPreserved` | A request uses the capability granted to its subtree. | Scope object identity is checked when binding. Equal display names confer no authority. |
| `SourceOwnsIdentity` | Unrelated events and replay preserve the source occurrence and tag. | The stored transition context binds the request. |
| `DistinctRequests` | Separate requests sharing a firing retain separate identities. | Authors assign distinct tags; existing transition validation rejects duplicates. |
| `AtMostOneCommit` | Repeated offers cannot commit a second response for one request. | Runtime completion keys deduplicate committed intents. |
| `NoWithdrawnCommit` | A captured proposal cannot bypass withdrawal in a later snapshot. | The source withdraws it and the runtime selects current proposals. |
| `Resolution` | Recorded work eventually commits or is withdrawn. | The model assumes strong fairness of description and commit actions. |

`Restart` drops volatile proposals and preserves durable origins and completions. The safety configuration explores three requests, two receivers, two source component names, one unrelated event, and at most three commits. Requests can share a triggering event. The liveness configuration permits repeated restarts but requires strong fairness so a proposal that is repeatedly enabled eventually commits. Permanent suppression by budget or another policy is outside that progress guarantee.

Six counterexample configurations independently introduce eager execution, binding to the current log head, tag conflation, foreign scope use, duplicate commitment, and stale proposal admission. The TLA runner expects each configuration to violate its designated invariant.

## Implementation checks

`src/component/composition/supplied-interaction.properties.test.ts` compares generated histories with a source-occurrence reference model using actual components, transition contexts, scopes, and `settleActor`. Histories include multiple requests per triggering event, unrelated events, withdrawal, repeated observation, commitment, and reconstruction with fresh capability objects. Separate properties check deferred event construction and rejection of missing or same-named foreign scopes.

The model abstracts away schemas, payloads, external effects, timer deadlines, and physical alarm storage. It does not establish arbitrary JavaScript callback purity. TLC checks finite instances; fast-check tests generated TypeScript executions against a reference model. Neither establishes an unbounded refinement proof from this specification to the implementation.
