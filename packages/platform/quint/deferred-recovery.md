# Deferred recovery

The models describe a watchdog and promise protocol for an actor host. They check finite protocol abstractions; they do not establish that the TypeScript runtime implements this design.

```text
                   shared alarm primitive
                    /                 \
             watchdog             promise service
         local work recovery     local + remote deadlines
                    \                 /
                     durable actor journal

EffectRequested
  -> EffectSettled { promise handle }
       -> local: commit deadline wake, supervise fibre, retain recovery wake
       -> remote: register durable owner + deadline, park recovery
  -> PromiseSettled { fulfilled | rejected }
       -> wake actor, derive subsequent work
```

## Checked properties

| Model | Positive initializers | Reachable states | Properties |
| --- | --- | --- | --- |
| [watchdog.qnt](watchdog.qnt) | `init` | 236 | Admission coverage, replacement before execution, later wakes preserved, eventual settlement |
| [recoveryBudget.qnt](recoveryBudget.qnt) | `init` | 128 | Bounded attempts, terminal failures stop, settled and blocked work have no recovery alarm, eventual stop |
| [interpreterVersion.qnt](interpreterVersion.qnt) | `init`, `initLegacy` | 146, 207 | Version adoption, per-budget attempt bounds, durable wake, stale-attempt fencing, eventual stop after deployment changes cease |
| [invocationReplay.qnt](invocationReplay.qnt) | `init`, `initUnsafe` | 53, 37 | Stable invocation identity, one logical child execution, durable reply acceptance, eventual parent outcome |
| [promiseLifecycle.qnt](promiseLifecycle.qnt) | `init` | 331 | Durable completion, supervised fibre exit, safe handoff, blocked deadline coverage, expiry admission, unchanged deadlines, one terminal winner, eventual settlement and timeout processing |

`recoveryBudget` includes terminating work, retryable failures forever, progress forever, terminal errors, and hung fibres. It checks three total attempts, two consecutive attempts without progress, and a two-tick attempt deadline. These are finite model parameters, rather than proposed runtime defaults. Progress resets the consecutive count while preserving the total budget. A watchdog probe of a live fibre does not start another attempt or extend its deadline.

`invocationReplay` includes two possible child invocation IDs and counts duplicate executions up to two. A restarted parent reruns its operation with the recorded invocation identity. The receiver deduplicates acceptance and retains its result. Unsafe work is rejected as interrupted after a crash, without automatic resubmission. A waiter subscribes and reads recorded state, covering completion both before and after subscription. The volatile-dependency mutation replaces durable child execution with a local producer that disappears on parent crash; stable identity alone cannot recover that missing producer.

`promiseLifecycle` models local and remote execution, completion before handle submission, fibre failure, restart, timeout, and late results. A remote wait transfers recovery responsibility to durable completion and deadline ownership. Local fibre exit produces a buffered failure even when the handle has not yet been submitted. A timeout durably rejects the promise without claiming that the executor stopped. Local handle submission commits an independent deadline wake. Two failed recovery attempts block the watchdog while preserving that wake through crashes. Committing timeout clears the promise wake and renews a blocked recovery budget once, admitting failure processing without restarting an expired producer. Clearing a recovery wake preserves the logical deadline wake. Completion, failure, and timeout share a serialized terminal decision.

## Counterexamples

The verification runner checks the following mutations. Safety checks report a finite violation; temporal progress checks report an infinite behavior that violates the stated progress property. TLC recognizes `terminalStable` as a temporal safety property and reports its finite counterexample with a safety-violation exit code.

| Mutation | Broken property | Witness |
| --- | --- | --- |
| No wake with admission | Coverage, settlement | Commit input, crash, remain pending without a wake |
| No replacement wake | Coverage, settlement | Return alarm delivery, crash background execution |
| No interrupted-delivery retry | Coverage, settlement | Consume alarm, crash before replacement persistence |
| Stale pass clears later wake | Coverage, settlement | Admit another message before clearing the completed pass |
| Finite interrupted-delivery retries | Coverage, settlement | Repeated pre-rearm crashes exhaust platform retries |
| Charge attempt after execution | Attempt bound, eventual stop | Crash every attempt before accounting |
| Keep budget in memory | Attempt bound, eventual stop | Restart grants another fresh budget |
| Reset total budget on progress | Attempt bound, eventual stop | Work reports progress forever without terminating |
| Retry known terminal error | Terminal stopping | Terminal failure retains the recovery loop |
| Extend live fibre deadline on probe | Eventual stop | A hung fibre keeps renewing its deadline |
| Generate another invocation ID | One logical execution | Parent crashes; replay starts a second child invocation |
| No receiver deduplication | One logical execution | Replay resubmits the same ID and executes it twice |
| Replay unsafe work | One logical execution | Restart repeats an operation without deduplication |
| Acknowledge volatile reply | Durable reply, parent outcome | Accept reply, crash waiter, lose the acknowledged result |
| Subscribe without reading state | Parent outcome | Result arrives before subscription and no further notification occurs |
| Wait on a volatile dependency | Dependency recovery, parent outcome | Crash destroys the producer; replay awaits a signal that cannot arrive |
| Unsupervised fibre exit | Exit accounting | Fibre fails; promise remains pending without a recorded failure |
| Accept volatile completion | Completion durability | Acknowledged completion disappears on crash |
| Park before registering owner | Pending coverage | Pending remote promise has no recovery or deadline owner |
| Clear deadline while parking | Pending coverage, settlement | Remote result never arrives and no expiry wake remains |
| Keep remote recovery armed | Remote parking | A registered remote promise retains an actor recovery wake |
| Reset deadline on restart | Deadline stability | An expired deadline becomes unexpired during recovery |
| Omit local deadline wake | Blocked deadline coverage, settlement | Exhaust recovery before expiry, crash, leave the promise without an alarm |
| Omit expiry admission | Timeout admission, processing | Commit timeout while the watchdog remains blocked |
| Replay expired producer | Expired replay exclusion | Reopen after deadline arrival and restart the producer |
| Overwrite terminal result | One winner, terminal stability | Timeout commits, then late completion changes the outcome |

```text
safe parent replay:
  invoke K -> child completes -> reply committed -> parent crashes
  replay  -> invoke K         -> deduplicated    -> read result

fresh identity:
  invoke K -> child accepted -> parent crashes
  replay  -> invoke K2      -> second logical execution

missing supervision:
  EffectSettled(local handle) -> fibre dies -> promise still pending

terminal race:
  timeout -> commit rejection -> late success -> ignored
```

## Assumptions and scope

These models describe protocol interfaces. The promise model combines bounded recovery with deadline ownership and timeout processing; the complete product of all models is outside its scope. The verification runner checks positive safety and temporal properties and requires each named negative variant to produce a counterexample. Successful completion of that runner means every expected checker result matched; a parser error or checker failure does not count as a counterexample.

`recoveryBudget` assumes atomic alarm consumption, attempt accounting, and replacement persistence. With weakly fair delivery and attempt timers, its pending work eventually settles or blocks without an eventual crash-free assumption. It permits failure and crash loops and bounds attempts rather than requiring successful execution. It does not bound duplicate platform alarm invocations or establish a wall-clock backoff duration. `watchdog` exposes the pre-rearm gap and shows why finite platform retries invalidate arbitrary-crash recovery in that gap.

Parent outcomes and promise settlements assume weakly fair service actions and an eventual crash-free, online suffix. Deadline arrival is a logical clock event; no numeric latency or Cloudflare delivery SLA is proved. Promise liveness assumes a deadline is present. A deliberately unbounded promise can remain parked indefinitely.

The child model abstracts payload consistency, result storage, and acceptance transactions. The promise model requires durable completion acceptance and serialized terminal commits; a volatile callback or fibre stack does not satisfy those assumptions. Before expiry, admitted local recovery reruns the originating act with its recorded reference and deadline. An expired promise settles without recreating its producer. The act must recreate its producer when replayed; retaining a `Deferred` from the previous process violates that contract, as illustrated by `initVolatileDependency`. [local-producer-retry.test.ts](../test/bun/local-producer-retry.test.ts) checks fresh producer creation across runtime reopening.

The promise model derives physical alarm presence from its set of watchdog and promise wake owners. Deadline arrival is a Boolean clock event; minimum timestamp selection, platform delivery retries, and multiple promises require separate scheduler refinement. Timeout processing is a fair successful action, with failures during that processing and stale budget fencing outside this abstraction. Polling retry budgets, terminal-result delivery budgets, backend abort, cleanup resources, and TypeScript conformance also require separate refinement. The shared [promiseDeadlineRecovery](../test/properties/recovery.ts) property exercises budget exhaustion, durable deadline recovery, one timeout, and absence of producer restart across storage reopening on Bun and Workerd SQLite.

## Reproduce

```sh
python3 packages/platform/quint/verify.py
```

The runner prints the temporary directory containing each generated TLA+ module, TLC configuration, checker log, and counterexample trace. Override tool locations with `TLA_JAVA`, `TLA2TOOLS_JAR`, and `APALACHE_JAR`. Each run selects a local compiler port to avoid collisions with another checker; `APALACHE_ENDPOINT` selects an existing server. The Quint compiler requires sandbox access to bind its port.

For an individual check, run from a temporary directory to keep backend files outside the repository:

```sh
quint verify /absolute/path/to/recoveryBudget.qnt --backend tlc --invariant invariant --temporal eventualStop
quint verify /absolute/path/to/recoveryBudget.qnt --backend tlc --init initPostcharge --temporal eventualStop
quint verify /absolute/path/to/invocationReplay.qnt --backend tlc --init initFreshIdentity --invariant oneLogicalExecution
quint verify /absolute/path/to/promiseLifecycle.qnt --backend tlc --init initOverwriteTerminal --temporal terminalStable
```
