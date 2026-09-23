# Categorical properties of components

Define the model, equality, and assumptions before claiming a composition law.

```text
Model                  Evidence                 Remaining obligation
machines + readouts -> generated law tests    -> general proof
admission protocol  -> bounded TLA+ checks   -> runtime refinement
```

## 1. Machine and coalgebra

Fix configuration, supplied data dependencies, and an event alphabet `E`, including recorded positions and identities. Assume total, deterministic evaluation and immutable snapshots. Replay equivalence requires equivalent supplied data as well as the same log.

```text
host data -> activate tree -> initial state S
                                    |
committed event E ------ step -------+----> next state S
                                    |
                                  output
                                    |
                      +-------------+-------------+
                      |             |             |
                  view V       proposals T*   interactions I
                 data only          |          capabilities
                             respond?(result)
                                    |
                             completion intent

step   : S x E -> S
output : S -> V x List(T) x Optional(I)
```

The public view contains data. It can include supported collections and dates; JSON serialization is a separate concern. [View validation](data.ts) rejects executable values and accessors. Readonly types and purity lint provide partial enforcement of immutable snapshots; fresh local mutation is allowed when earlier snapshots remain unchanged.

Proposals describe work and may carry a typed `respond` callback. The optional `interactions` field exposes other snapshot-bound capabilities, with types chosen by the component. Cancellation is the optional `interactions.cancel` capability. Sibling composition collects child cleanup in order, independently of ordinary proposal selection. Parents explicitly forward cleanup when wrapping children. Calling a pure capability can derive data or describe work; the runtime owns commitment and effect execution. The interface alone does not enforce callback purity.

[Data dependencies](dependencies.test.ts) are declared on the component and supplied during activation. Parents receive bound child handles; component definitions expose no public runtime machine.

Choose a proposal-description function `D`. The pure declaration layer is an initialized coalgebra:

```text
B = V x List(Description)
readout(s) = (output(s).view, map(D, output(s).transitions))

F(X)           = B x (E -> X)
F(f)(b, k)     = (b, f compose k)
coalgebra(s)   = (readout(s), e => step(s, e))
initial        = s0
```

This is the Moore-machine formulation in [Spivak, Proposition 1.5, p. 11](https://dspivak.net/grants/AFOSR2020-Topos-ContextDependence.pdf#page=11). Interactions, response callbacks, cancellation, and effect execution are outside this chosen readout.

Replay is a left fold, preserving event metadata:

```text
run(s, [])       = s
run(s, h ++ [e]) = step(run(s, h), e)
run(s, h ++ k)   = run(run(s, h), k)     by induction on k
```

## 2. Category and product

Forget readouts, interactions, and caches. Initialized machines over the same `E` form a category:

```text
Objects:     (S, s0, step)
Morphisms:   state maps f satisfying f(s0A) = s0B and

             SA --------stepA(e)------> SA
              |                         |
              f                         f
              |                         |
              v                         v
             SB --------stepB(e)------> SB

Identity:    identity function
Composition: function composition
```

Identity and composition preserve these conditions. Coalgebra morphisms with fixed `E` and `B` must also preserve readouts: `readoutB(f(s)) = readoutA(s)`.

The synchronous product in the category that forgets readouts is:

```text
initial       = (s0A, s0B)
step((a,b),e) = (stepA(a,e), stepB(b,e))

                      X
                      |
             unique <f,g>
                      |
                      v
             A <---- AxB ----> B
                 projections
```

For machine morphisms `f: X -> A` and `g: X -> B`, the unique map is `x => (f(x), g(x))`. The terminal machine has one state and ignores events. This product claim concerns state evolution; merging public views may discard information.

## 3. Equality and bisimulation

```text
stateC(h)    = run(s0C, h)
traceD(C,h)  = readoutD(stateC(h))

A ~=D B      equal traces for every admissible finite history
```

[Law tests](composition/laws.properties.test.ts) use `D(t) = (key, kind, input)`. Equal descriptions do not establish equal response callbacks, effects or interactions. Private state shapes and object identities need not match.

A relation `R` establishes declaration-trace equality when initial states are related and every related pair satisfies:

```text
                  equal readouts
                       |
                 a ----R---- b
                 |           |
             step(e)      step(e)       for every e
                 |           |
                 v           v
                 a' ---R---- b'
                       |
                  equal readouts
```

This is a bisimulation for the chosen readout. Induction gives equality at every prefix. Restricting to legal histories requires matching admissibility and closure under legal extensions. Generated tests sample these obligations; they do not prove them universally.

```text
equal views now          -/-> equal future behavior
equal declaration traces -/-> equal interactions, completions, or effects
```

Full substitution requires agreement on everything the parent can access: previews, interactions, method availability, completions, and effects under a specified environment.

## 4. Ordered siblings

[siblings.ts](composition/siblings.ts) combines children under a fixed view algebra:

```text
                    event
                 /    |    \
                v     v     v
                A     B     C
                 \    |    /
                  v   v   v
             combine views
             concatenate proposals
             explicitly project interactions
                      |
             optional reconciliation
```

For plain composition without reconciliation:

```text
Required view algebra:
  combine(empty, v) = v = combine(v, empty)
  combine(combine(a,b),c) = combine(a,combine(b,c))

Resulting laws:
  I tensor A             ~=D A
  A tensor I             ~=D A
  (A tensor B) tensor C  ~=D A tensor (B tensor C)

Private state:    ((a,b),c) <--- reassociation ---> (a,(b,c))
Proposal order:  [a,b,c]    =                     [a,b,c]
```

Assumptions: valid compositions, stable leaf identities, compatible requirements, and noncolliding keys. The output cache relies on view associativity; TypeScript does not verify it.

Sum is an associative view merge; rounded pairwise average is not. Custom sibling interactions require explicit forwarding through `options.interactions`, including singleton compositions. Cancellation is aggregated from child outputs independently of that projection. The laws above compare views and proposal descriptions only. Extending them to interactions requires coherent forwarding across grouping. Sibling order is observable. No symmetric-monoidal structure is established here.

## 5. Parents and interaction

[parent.ts](composition/parent.ts) manages the lifecycle:

```text
event -> step children -> bind current + previous handles
                                      |
                                      v
                              step parent's state
                                      |
                                      v
                             parent output
                      view + proposals + interactions
```

Withholding proposals retains child updates from committed events. Handles bind queries to a snapshot. Materialized component definitions cache one output per snapshot.

```text
child.output()             -> { view, transitions, interactions? }
child.output().interactions.cancel(...)  -> cleanup proposals
child.admission()          -> reservation cursor
    .preview(intent)       -> next hypothetical cursor
    .output().view         -> hypothetical public data
```

Admission accepts only intent objects from the bound child's original output, each at most once along a cursor chain. It folds their described events into hypothetical state with reserved positions and a bound timestamp. The cursor exposes the resulting view and further reservations. It exposes no proposals, interactions, and performs no commit or external effect. Constructing the hypothetical output must remain pure. Reservation predictions require the eventual committed events, ordering, and relevant metadata to agree.

Typed composition has the shape of substitution into ordered slots:

```text
P : (I1, I2) -> I             P
                            / \
P(A, Q(B,C))               A   Q
                             / \
                            B   C
```

Interfaces include views, interactions, response inputs and requirements. This suggests a colored, nonsymmetric operad. An operad-algebra claim needs an interpretation preserving identity and associative substitution across the full lifecycle. Existing tests cover restricted cases. An identity wrapper forwards output. Forwarding output carries the child's view, interactions, and proposals with their response callbacks. A parent explicitly chooses the public view and capabilities it exposes.

Spivak's [arenas, pp. 6-7](https://dspivak.net/grants/AFOSR2020-Topos-ContextDependence.pdf#page=6), allow incoming interaction types to depend on the current position. Our application is snapshot-dependent availability:

```text
child.output().transitions
          |
          +-> proposal --------------------------> runtime
          |     execution                            |
          |                                          v
          +-> proposal.respond(result) -> intent -> commit
                optional, child-owned                |
                                                     v
                                               event -> step

Parent policy:
  allow  -> forward proposal
  wait   -> withhold proposal; retain pending state
  reject -> replace proposal with completion intent
```

The child binds `respond` while constructing its proposal with `withResponse(execution, respond)`. The parent supplies a result without accessing private state or looking up a call. When the proposal has registered ownership, the helper validates the returned intent against that component. A proposal without `respond` offers no completion interaction through this interface.

```text
Result                         -> callback input type
forward proposal               -> preserve callback
filter proposal                -> omit callback from current output
retain an old proposal         -> retain its snapshot-bound callback
call respond                   -> describe completion, without committing it
```

Filtering does not revoke captured callbacks. A rejection must replace execution in the parent's output; constructing a completion alone does not suppress execution. Dynamic tools and stale proposals need application and runtime policy. The opposing directions resemble dependent lenses, discussed on page 7; establishing that model requires the proposal and commit protocol. The diagram alone supplies no lens laws.

[Interaction properties](composition/interaction.properties.test.ts) separate three decisions in a single-pending-call model:

```text
bound callback(result) -> candidate completion intent
                               |
parent publishes it? -----------+  no -> no commit
                               |
runtime key already recorded? -+  yes -> no duplicate commit
                               |
                         completion event
                               |
child matches request occurrence?
         |                     |
        yes                    no
         |                     |
       settle             preserve pending work
```

The runtime can commit an unrecorded retained completion when a parent publishes it. It does not infer whether that response still matches current child work. The fixture uses the originating event position, component, and transition tag to match a request occurrence; matching only a reused call ID admits a stale response. This is a tested child protocol, not a framework-wide freshness guarantee.

Generated commands request work, construct responses, deliver completions repeatedly, and reconstruct state by replay. An independent request-occurrence model checks accepted results. Nested identity wrappers preserve completion event descriptions and subsequent readouts. Coverage is limited to this single-slot protocol; concurrent pending calls, cancellation, arbitrary policy wrappers, and general interaction equivalence require separate evidence.

[Policy interaction properties](composition/policy-interaction.properties.test.ts) extend the fixtures to multiple pending calls across two to four siblings. Generated histories change nested allow/wait/reject policies, settle real runtime work, and restart replay. An independent ledger checks pending requests, accepted results, and actual executions. Flat and grouped siblings agree on response descriptions and subsequent readouts. These wrappers govern effects and forward completion intents, so an outer execution hold preserves an inner rejection response. They model this policy contract rather than the full budget or permissions implementations.

Sibling response isolation depends on the child protocol. Every sibling receives committed events; a child may intentionally react to another child's response. The tested fixture settles only the request occurrence named by the response identity.

## 6. Restricted wrapper laws

Pure view maps preserve work while transforming the public data:

```text
map(id, A)          ~=D A
map(g, map(f, A))   ~=D map(g compose f, A)
```

Selection reconcilers receive fixed history and combined view. They return distinct input proposal objects, possibly reordered. [reconciliation.ts](composition/reconciliation.ts) rejects invention and duplication.

```text
proposals -> q -> selected -> p -> selected again

select(p, select(q, xs)) = (p compose q)(xs)
```

Identity and associativity follow from function composition. These laws cover selection wrappers, not arbitrary stateful parents. A functor claim requires source and target categories, an action on morphisms, and preservation proofs.

```text
Order matters: each call costs 1; capacity is 1

[write, read] -> permission -> [read]  -> capacity   -> [read]
[write, read] -> capacity   -> [write] -> permission -> []

Shared and separate capacities differ:

[A, B] -> budget(1)                -> [A]
 A -> budget(1), B -> budget(1)    -> [A, B]

Neither equation is a general law:
  P(Q(A))          ~=D Q(P(A))
  P(A tensor B)    ~=D P(A) tensor P(B)
```

Response-aware comparison adds an obligation to declaration bisimulation:

```text
s R t
  |
  +-> equal public declarations
  +-> corresponding proposals offer the same response input types
  +-> for every offered result r and commit timestamp:
        respond(left, r)  -> equal intent identities and event descriptions
        respond(right, r) -> equal intent identities and event descriptions
  +-> step(s, e) R step(t, e) for every committed event e
```

Induction on a common committed history preserves the relation. Equal response events can extend that history, preserving related states after the response. This argument assumes pure, total callbacks and identical event metadata; effect execution still needs an environment relation. Generated interaction tests instantiate these obligations for specific protocols and sampled histories and results.

For an identity wrapper that delegates output and preserves child stepping, corresponding responses are the child's callbacks. For plain sibling grouping, concatenation preserves the ordered proposals and their callbacks, while the state reassociation map preserves stepping. Thus response behavior is preserved under these restrictions. Arbitrary interaction projections and policy wrappers need their own preservation arguments.

## 7. Substitution proof sketch

Declaration equality forgets capabilities. Substitution uses a stronger relation over the public protocol, including retained values. This proof sketch concerns the abstract boundary described here. It does not assert that every TypeScript parent or effect satisfies its assumptions.

```text
A ~I B
  |
  |  any admissible parent context P[-]
  v
P[A] ~I P[B]

closed with related environments and matching runtime choices:
  same public data, committed log, and observable external actions
```

### Local equivalence

Fix the interface types, component identities, key interpretation, event alphabet, and supplied data. Let `R` relate child states and let `W` pair retained handles, proposals, callbacks, intents, and admission cursors. `W` records correspondence across time, including which proposals belong to which snapshot. Object allocation itself is unobservable.

```text
                 child state a R b
                         |
             output / capability
                         |
                         v
       equal data + corresponding capabilities in W
                         |
                same related arguments
                         |
                         v
       equal data + corresponding capabilities in W'

           W subset W': old capabilities stay paired
```

Write `A ~I B` when initial states are related and the following local obligations hold in both directions for every reachable related configuration:

| Boundary operation | Obligation |
| --- | --- |
| `output()` | Equal data, ordered proposal metadata, and capability availability |
| `respond(r)` and declared interactions | Related arguments produce equal data or related work; pure calls preserve child state |
| `interactions.cancel(c)` | Equal availability and related ordered cleanup proposals for equal cancellation input |
| `admission()` and `preview(t)` | Equal views and matching acceptance or errors for paired proposals, including old or repeated proposals; returned cursors remain related |
| Intent materialization | Equal keys, invocation metadata, and ordered events for every equal runtime timestamp |
| Committed event | `a R b` implies `stepA(a,e) R stepB(b,e)` |
| Effect execution | Under related environments, match external actions, event emissions, outcomes, blocking, and cancellation; successor environments remain related |

Capability relations are type-directed: data use structural equality; finite containers relate entries in order; callable capabilities relate pointwise on related arguments. Callable results extend `W`. The same obligations apply to retained capabilities after later commits. Admission uses concrete object membership internally, so provenance must agree even though arbitrary reference comparison is excluded. Equal keys alone do not imply equal admission behavior.

This is a local, symmetric simulation definition. It does not quantify over parent contexts. It includes hypothetical event extensions reachable through admission and cancellation inputs allowed by the interface. If an interface accepts user-supplied functions as arguments, their relation and application rule must also be specified; those interfaces are outside the first-order fragment considered below.

### Admissible parents and runtime

An admissible parent is a program built from the following operations. Its private memory may contain public data and retained capabilities.

```text
read data -> compute / branch / iterate on data
call a public capability with related arguments
store or retrieve data and capabilities
forward / withhold / reorder / replace proposed work
construct own work using the same rules
receive a committed event -> update own state
```

All data computations and boundary queries are pure and total. Capability calls may return a specified error; paired calls must return the same error. Parents cannot inspect private snapshots, function source, reference identity, allocation counts, or execution time. They cannot mutate shared values or use ambient effects while deriving output. Capability membership checks are available through admission. Selection retains paired proposals; it does not require the same JavaScript object in two executions. Parent-created effects must satisfy the effect obligation above. Initialization, child-first stepping with both previous and current handles, output derivation, interactions, and cleanup all obey these rules.

The runtime makes choices from public protocol data. Compare the same choices of selection, timestamp, log position, external input, and effect scheduling, with equal initial logs and related supplied environments. Deduplication, commit validation, cancellation, and replay use the same rules. Effect equivalence concerns complete boundary traces, including direct log appends and external actions, rather than just returned events. Wall-clock races and different service behavior are outside this coupling. For a nondeterministic runtime, the assumptions require matching choices in both directions, giving equal sets of observable traces.

### Proof sketch

Lift `R` to configurations containing the parent, child, runtime, environment, and retained values:

```text
     parent memory pA       ~W       parent memory pB
     child state a           R       child state b
     retained values WA   paired     retained values WB
     committed log L         =       committed log L
     environment zA          Z       environment zB
```

First prove a boundary-program lemma by induction on the parent program. Equal data give equal results under each pure data operation and select the same branch. A capability application preserves the relation by its local obligation and extends `W`; storing, retrieving, forwarding, or dropping values preserves pairing. Sequential composition applies the induction hypothesis twice. Finite iteration applies it once per iteration. Parent-created closures are represented by their program and captured related memory. Thus every terminating parent query or state update returns related values and leaves related memory. This argument uses only the listed program operations, without assuming contextual equivalence as a premise.

Now perform induction on execution steps:

```text
Action                   Why the lifted relation is preserved
initialize               R holds initially; parent-program lemma
query / respond / store  lemma; extend W without changing the log
withhold / publish       paired selections; child states unchanged
materialize / commit     equal events and keys; equal validation and dedup
                         step every child; use R; update parent by lemma
preview                  equal reserved events, positions, timestamps;
                         apply R per event; paired provenance and cursors
execute / cancel effect  effect obligation and matching runtime choice
restart                  same log and data; fold step; rebuild parent
```

For commitment, child-first evaluation gives related previous and current handles before the parent reducer runs. Existing retained callbacks stay in `W`, so an old response is handled by the same argument as a fresh response. The claim requires matching acceptance behavior; it does not require every child to reject stale responses. Restart either discards retained process-local values on both sides or reconstructs them through replay. The same restart policy must be used in both executions.

Each matched step has equal visible labels and preserves the lifted relation. Induction gives equal finite traces. Matching all finite prefixes gives equal infinite observable traces under the stated step semantics. Fair liveness transfers only when matching also preserves enabled actions and the chosen fairness condition. The argument supplies no fairness or eventual-success assumption itself.

Apply the same lifting argument at each ancestor of a finite component tree. Unchanged siblings start in equal states and receive equal committed events, including responses they intentionally observe. Therefore replacing a child preserves the whole tree's behavior. This outlines the displayed substitution claim for admissible contexts. A complete formal derivation remains an obligation.

### Categorical consequence and limits

```text
context identity:       Id[A] = A
context substitution:  (P compose Q)[A] = P[Q[A]]
congruence:             A ~I B => P[A] ~I P[B]

therefore substitution is well-defined on equivalence classes [A]I
```

For a fixed typed first-order protocol and the assumptions above, identity, reversal, and relational composition give reflexivity, symmetry, and transitivity of `~I`. Admissible contexts are closed under plugging, so the congruence descends to the quotient. The intended conclusion is behavioral substitution. Additional equations about view algebras, sibling regrouping, or arbitrary interaction projections retain their separate obligations.

Spivak's [position-dependent distinctions, pp. 6-7](https://dspivak.net/grants/AFOSR2020-Topos-ContextDependence.pdf#page=6), motivate exposing the available interactions at each state. Here the relevant state includes parent memory, retained capabilities, and runtime stages. The substitution argument above is for this operational model; identifying it with a particular polynomial coalgebra or operad algebra requires a separate interpretation theorem.

[Substitution checks](composition/substitution.properties.test.ts) replace an incremental child with a history-derived child inside generated parent contexts. They compare response publication, previews, cancellation, effect execution, sibling observations, and replay. Negative controls distinguish changed response behavior and reference-sensitive contexts. These are executable instances of the proof obligations. They do not mechanically verify the proof or certify arbitrary application components.

The remaining implementation obligations are to establish each concrete child's local equivalence, show that application parents use admissible operations, and prove runtime refinement of these abstract steps. Readonly types, bound handles, purity lint, property tests, and bounded TLA+ models provide partial evidence for those obligations.

### Occurrence identity: an induction proof

This narrower safety theorem concerns the tool implementation. Fix one component instance and its log. Assume distinct committed event positions, replay with those same positions, immutable captured call records, and unmodified completion events constructed by the tool response callback. The theorem does not cover forged transition metadata or mutation through casts. It concerns pending membership; another request's accumulated event history may still change.

```text
request at position i -> captured call.context -> respond_i(result)
                                                   |
                                             ToolReturned
                                          transitionRef.seq = i
                                                   |
                                       pending := pending minus {i}
```

Let `P_n` be the pending-call map after a valid committed prefix of length `n`. Let `H_n` pair every retained response callback with the request position from which it was obtained. `H_n` is proof notation; the runtime needs no callback registry. Use the following invariant:

```text
I(n):
  each entry P_n[i] retains the context of ToolCalled at position i
  each callback (respond_i, i) in H_n constructs a result stamped i
  calling respond_i does not mutate P_n
```

**Binding lemma.** [Tool output](../../../agent/src/component/tool/machine.ts) closes over `current.call`; its response uses `call.context.intent("answer", ...)`. [bindTransitionContext](../transition/transition.ts) closes over the originating event. [eventAt](../event.ts) stores its position in a private weak map and gives each positioned event a fresh object. A later `eventAt` call cannot reposition that captured object. Creating the intent fixes a frozen reference containing that position, and materialization stamps the single `ToolReturned` event with the reference. Under the immutability assumption, later reducer steps cannot retarget this callback. The result value and materialization timestamp do not select a request.

**Base case.** `P_0` and `H_0` are empty, so `I(0)` holds.

**Inductive step.** Assume `I(n)`. The tool reducer has these cases for the next committed event:

| Event | Pending-map update | Preservation |
| --- | --- | --- |
| Owned `ToolCalled` at fresh position `j` | Insert `j` with that event's context | The new entry has the required identity; existing call records retain theirs |
| `ToolReturned` stamped `i` | Remove key `i` | Surviving entries retain their contexts; captured callbacks retain their original bindings |
| Unstamped `ToolReturned` | Remove nothing | No pending identity changes |
| Turn completion, failure, or cancellation | Filter calls in the matching turn and epoch | Deletion cannot retarget a surviving entry or retained callback |
| Any other event or unowned request | Preserve pending keys | Appending to per-call history creates new records while preserving each captured call |

Thus every committed event preserves the pending-entry clause. Reading output may extend `H_n` with callbacks; the binding lemma establishes their identity. Constructing, retaining, withholding, publishing, or invoking those callbacks does not update the committed machine snapshot. These operations preserve `I(n)` between commits. Therefore `I(n + 1)` holds. Induction establishes the invariant for every finite valid log prefix, without a fixed history-length bound.

**Noninterference corollary.** Take any retained `respond_i`, any result, and any pending request position `j != i`. If its completion is committed as the next event, the reducer performs:

```text
P_next = update histories in P_n, then remove key i

j != i => (j in DOMAIN P_next <=> j in DOMAIN P_n)
```

Consequently a response for request `i` cannot settle request `j`. If `i` is already absent, duplicate or late delivery removes no pending request. This corollary does not require runtime deduplication. A turn-terminal event can separately remove `j` through its own cleanup rule.

**Replay corollary.** Replay starts with the empty map and applies the same reducer to the same positioned events. Applying the induction at each replay prefix gives the same occurrence bindings and pending membership. Reconstructed callbacks therefore refer to the same request positions. Process-local callbacks need not survive a restart; any retained callback evaluated in the mathematical model still refers to its original occurrence.

[Tool properties](../../../agent/src/component/tool/tool.properties.test.ts) exercise callbacks captured before newer requests, repeated invocation after settlement, reused provider call IDs, out-of-order delivery, and replay. These are sampled implementation checks. [ResponseIdentity.tla](../../tla/component/ResponseIdentity.tla) gives a TLAPS-checked abstraction of the identity argument. `InitialInvariant` proves the base case; `StepInvariant` proves preservation, including stuttering; `Safety` lifts the invariant to all behaviors; `CommitPreservesOtherRequests` proves the pending-membership corollary. `Requests` is an arbitrary set, with no finite configuration or history-length bound. TLAPM `f14d233` discharged all 10 obligations with `--strict --nofp`.

The proof represents a captured callback as an immutable envelope with an origin and target. It includes delayed response construction, publication, withholding, duplicate commitment, cleanup, and restart. Restart assumes exact reconstruction of durable issued and pending sets; the proof does not derive them from an event log. The JavaScript closure-to-envelope correspondence and the replay corollary above remain code-level arguments supported by tests. This proof does not establish runtime refinement, liveness, or the general substitution theorem.

## 8. Evidence and limits

| Claim | Evidence | Scope |
| --- | --- | --- |
| Synchronous product and replay | [Sibling properties](composition/siblings.properties.test.ts) | Generated fixtures and prefixes |
| Identity, regrouping, counterexamples | [Composition laws](composition/laws.properties.test.ts) | Restricted readouts and selection wrappers |
| Snapshot isolation and child-first stepping | [Children](composition/children.test.ts), [readonly](readonly.test.ts), [views](composition/view.test.ts) | Pure implementations and immutable reachable values |
| Data-only views and explicit interactions | [Data checks](data.test.ts), [view composition](composition/view.test.ts) | Runtime validation and typed capability forwarding |
| Supplied data dependencies | [Dependency checks](dependencies.test.ts) | Activation, requirements, and separate data contexts |
| Bound response callbacks | [Completion scenarios](composition/settlement.test.ts) | Typing, ownership, decoration, replay, forwarding, and filtering |
| Completion interaction and acceptance | [Interaction properties](composition/interaction.properties.test.ts) | Generated single-slot model, identity wrappers, runtime deduplication, and stale-response control |
| Multiple pending calls and policy responses | [Policy interaction properties](composition/policy-interaction.properties.test.ts) | Generated sibling grouping, policy changes, real execution, and replay |
| No invented or duplicated selections | [Sibling tests](composition/siblings.test.ts) | Reconciliation boundary |
| Replay refinement | [Refinement helper](refinement.ts) | Includes cancellation; omits response callback behavior |

```text
Composition
  3 leaves; concatenate names and sum counts in the view; 4 policies; positive history bound 3
  checks: identity, associativity, view projection, selection boundary
  counterexamples: order, distribution, lossy/arbitrary observation

ComponentAdmission
  2 calls; capacity 1; at most 2 permission changes
  checks: replay, admission identity, capacity, permission, execution order
  counterexamples: stale selection, revocation, bypass, early execution
```

Sources: [Composition.tla](../../tla/component/Composition.tla), [ComponentAdmission.tla](../../tla/component/ComponentAdmission.tla), [admission configuration](../../tla/component/ComponentAdmission.cfg). `Composition` models data-view algebras and proposal selection. Interaction behavior is checked separately. Abstract admission records are model vocabulary. They do not prescribe agent event names.

```text
TLC success = exhaustive check of the configured finite model
            != unbounded proof
            != proof that TypeScript refines the model
            != eventual completion
```

Safety and liveness have different proof obligations:

```text
Core safety         snapshot isolation; legal selections; keyed commitment
Child protocol      matching responses; domain accounting; valid state changes
Parent policy       allow / wait / replace; retain committed child updates
Liveness            enabled work + scheduling + successful dependencies
                    + commitment -> protocol progress
```

Admission safety needs a mapping to actual commits and execution. Liveness needs explicit environment and scheduling assumptions; composition alone does not guarantee completion. Domain guarantees such as budget capacity, tool settlement, and valid compaction cuts require domain tests. Associativity guarantees neither hard caps on unknown future cost nor sibling conflict detection. Blocking execution must preserve result processing and cleanup.

[InteractionSubstitution.tla](../../tla/component/InteractionSubstitution.tla) compares distinct child representations under the same finite parent command language:

```text
                 same parent commands and environment results
                          /                    \
            incremental reducer           history query
                   |                           |
             private live state          independent durable log
                   |                           |
                   +------ equal boundary -----+

capture -> respond -> draft -> publish / withhold -> selected -> commit
    |                                                     |
    +-> preview once                            admitted effect -> result

cancel -> cleanup draft, even while policy waits
restart -> discard volatile handles; reconstruct from each log
```

The left child updates a private state map with `Reduce`. The right child uses `ReplaySlot` to query the latest request and its matching results directly. Each side has its own log, retained handle, draft, selection, in-flight work, preview, and external-action trace. Equal data do not establish `Substitution`: offered cleanup and response behavior must also agree. The coupled commands preserve correspondence; `Substitution` detects differing capability availability before joint action guards can hide it.

| Check | Obligation |
| --- | --- |
| `ReplayAgreement` | Incremental state equals a fresh query of its own durable log |
| `Substitution` | Views, proposal and cleanup availability, retained capabilities, drafts, selections, previews, logs, flights, and external-action traces agree |
| `UniqueCommits` | A transition kind and request occurrence commit at most once |
| `ExecutionAdmitted` | Each observed execution has its matching admission in the durable log |

The configurations cover one slot with two occurrences and two slots with one occurrence each, up to four committed events and one external execution. Parent commands allow policy changes, rejection, waiting, publication of retained responses, completion after cancellation, and restart. Preview covers one retained admission proposal and repeated-reservation rejection. Results range over two environment values and one rejection value. These are explicit bounds, not an enumeration of arbitrary parents, cursor chains, or effect programs.

Negative controls change response values, hide cleanup, mutate state before commitment, ignore occurrence identity, or duplicate commits. Each must violate its named invariant. Response and cleanup controls show why equal declaration descriptions are insufficient for substitution.

The abstract preservation argument has three obligations:

```text
Init                         => Related
Related /\ each parent step => Related'
Related                      => equal observable behavior
```

The model makes these obligations concrete for its command language. `Request` and `Commit` connect the incremental reducer to the independent history query. Capability calls preserve live state and extend paired parent memory. Publication changes only the selection. Execution records the same external action under paired admission guards; environment return constructs paired drafts. Restart discards volatile values on both sides and reconstructs live state from the durable log. TLC checks reachable states within the configured bounds. It does not discharge the unbounded inductive obligations through TLAPS.

The model couples environment choices, exposes run starts, and permits restart before a result commits. It does not model arbitrary external side effects, abort signalling, fairness, eventual completion, or TypeScript refinement. Preview provenance is represented by a retained snapshot and its log head; JavaScript reference identity remains outside the model. The general substitution claim in section 7 remains a proof sketch. Concrete component equivalence, admissible application parents, and runtime refinement remain obligations. [TCA's TestStore](https://github.com/pointfreeco/swift-composable-architecture/blob/377da4061db10d26337a71bb279c506bb951f50f/Sources/ComposableArchitecture/TestStore.swift) suggests exhaustive scenario accounting alongside generated laws and bounded models.

## References and checks

[Seven Sketches](https://arxiv.org/abs/1803.05316v3): sections 3.2 and 3.3.2 for categories and functors; Definition 3.86 for products; section 4.4.3 for monoidal structure; section 6.5 for operads; sections 7.1 and 7.5.3 for behavioral safety.

```sh
bun test packages/core/src/component
TLA2TOOLS_JAR=/absolute/path/tla2tools.jar bun run tools/tla.ts Composition ComponentAdmission InteractionSubstitution OfferedRouting
```

`TLA_JAVA` selects a Java executable. [tools/tla.ts](../../../../tools/tla.ts) checks expected counterexamples. Documentation lint scans `docs/`; this file needs an explicit prose check outside that scan.

## Stable component inputs

A component's `input` field exposes typed request constructors independently of its private state and output. Calling a constructor describes information for the receiver; it does not evaluate output, commit events, or execute effects. A caller binds the request to a recorded event and tag through `context.interaction(tag, request)`. The resulting intent uses the existing runtime commitment and completion machinery.

```ts
const scope = interactionScope("counter")
const counter = component({
  name: "counter",
  input: {
    add: scope.define<number>((amount, { id, at }) => ({
      type: "CounterAdded", amount, id, at
    }))
  },
  initial: () => 0,
  step: (state, event) => event.type === "CounterAdded"
    ? state + Number(event.amount) : state,
  output: state => ({ view: state, transitions: [] })
})

const request = counter.input.add(2)
// request binds to a recorded cause through context.interaction("increment", request).
```

Inputs declared on a component are available for binding in that component and its descendants. A parent can also bind its direct children's declared inputs. Child inputs do not automatically become available in sibling subtrees; a wrapper can explicitly re-expose a child's input through its own `input` field. Constructor scopes are checked by object identity, independently of their display names. These rules are tested in `composition/supplied-interaction.properties.test.ts`.

Output interactions capture a snapshot and can depend on its state, including pending response and cancellation capabilities. Stable inputs remain callable regardless of the current snapshot. The receiver's reducer determines how each recorded input affects its current state; availability of a constructor does not guarantee acceptance in every state. Neither input constructors nor output interactions may mutate component state or perform effects while describing work.
