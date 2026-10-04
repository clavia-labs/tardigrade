# Watchdog

The [system contract map](../../core/quint/README.md) connects host recovery to atom projection, runtime admission, input verification, cancellation, and thread invocation.

[watchdog.qnt](watchdog.qnt) models atomic message admission and a shared durable recovery alarm for two actors. Each actor receives one message that requires two recorded effect settlements. Crashes discard staged messages and volatile execution; committed messages, settlements, and persisted alarms survive.

[Deferred recovery](deferred-recovery.md) covers bounded recovery, local fibre supervision, parent invocation replay, remote promise parking, and deadlines. Run `python3 packages/platform/quint/verify.py` from the repository root to check all four models and require the named negative variants to produce counterexamples. The runner uses the installed TLC and cached Apalache JAR, keeps compiler output and traces in `/tmp`, and fails on an unexpected checker result.

```text
receive -> commit(message + immediate alarm) -> acknowledge

alarm fires -> persist recovery alarm -> drive journal-derived work
                                      |
                         crash -------+-> alarm retries / fires again
                                      |
                         settled -----+-> clear covered wake
                                          preserve later admissions
```

## Properties

TLC exhaustively checked 236 reachable states from 890 generated states using `init` and `step`. `invariant` holds through arbitrary crashes: pending work has a wake, an unacknowledged retryable delivery, or an active pass; effects run with a replacement wake persisted; finishing a pass requires its covered actors to be settled. `eventualSettlement` holds under weakly fair alarm delivery and execution, terminating effects, and an eventual crash-free suffix. Ten deterministic scenario tests also pass.

| Initializer | `wakeCoverage` | `eventualSettlement` | Failure |
| --- | --- | --- | --- |
| `init` | Pass | Pass | Recovery survives crashes |
| `initWithoutAdmissionWake` | Counterexample | Counterexample | Committed input loses its execution after a crash |
| `initWithoutRenewal` | Counterexample | Counterexample | Acknowledged delivery cannot recover background work |
| `initWithoutRetry` | Counterexample | Counterexample | Crash between consuming the alarm and rearming |
| `initStaleClear` | Counterexample | Counterexample | A completed pass clears a later message's wake |
| `initFiniteRetry` | Counterexample | Counterexample | Repeated interrupted deliveries exhaust retries |

`returnDelivery` permits actor execution to outlive successful alarm acknowledgement. This overapproximates hosts that detach work from the alarm invocation. The missing-renewal counterexample uses that behavior; a host that awaits all actor work retains platform retry coverage until its invocation returns.

## Platform assumption

The positive model assumes an interrupted alarm delivery remains retryable until acknowledged. This protects the interval between alarm consumption and replacement persistence. Rearming before execution protects subsequent work even after acknowledgement. The recovery delay is abstracted as fair eventual delivery; this model establishes no latency bound.

Finite retries invalidate the arbitrary-crash guarantee even when crashes eventually stop. `initFiniteRetry` allows two retries and produces this counterexample:

```text
commit message + wake
fire         -> wake consumed
crash        -> retry 1 available
redeliver
crash        -> retry 2 available
redeliver
crash        -> retries exhausted
no more crashes, pending work, no wake -> stranded forever
```

A platform with finite retries needs an additional recovery path, atomic consumption and replacement, or an explicit bound on interrupted deliveries before rearming. Fair delivery cannot help once no alarm or retry remains.

The finite model covers interleavings of two admissions and four settlements. It does not prove arbitrary actor counts, arbitrary event streams, external effect idempotency, clock behavior, or conformance of the TypeScript implementation. Repeated watchdog delivery requires replay-safe effect handling in the runtime.

## Reproduce

Run from the repository root with Quint 0.32.0 and Java available:

```sh
quint typecheck packages/platform/quint/watchdog.qnt
quint test packages/platform/quint/watchdog.qnt --backend typescript --max-samples 1
quint verify packages/platform/quint/watchdog.qnt --backend tlc --invariant invariant --temporal eventualSettlement
```

Check each negative variant separately for safety and liveness. Each command should report a counterexample and exit unsuccessfully:

```sh
for watchdog_init in initWithoutAdmissionWake initWithoutRenewal initWithoutRetry initStaleClear initFiniteRetry; do
  quint verify packages/platform/quint/watchdog.qnt --backend tlc --init "$watchdog_init" --invariant wakeCoverage
  quint verify packages/platform/quint/watchdog.qnt --backend tlc --init "$watchdog_init" --temporal eventualSettlement
done
```

Quint's TLC backend uses its cached Apalache JAR. To use the workstation's installed TLC directly and keep compiler output outside the repository:

```sh
watchdog_model="$PWD/packages/platform/quint/watchdog.qnt"
watchdog_dir=$(mktemp -d /tmp/tardigrade-watchdog.XXXXXX)
cd "$watchdog_dir"
PATH="/opt/homebrew/opt/openjdk/bin:$PATH" quint compile "$watchdog_model" --target tlaplus --invariant invariant --temporal eventualSettlement > watchdog.tla
cat > watchdog.cfg <<'EOF'
INIT q_init
NEXT q_step
INVARIANT q_inv
PROPERTY q_temporalProps
EOF
/opt/homebrew/opt/openjdk/bin/java -XX:+UseParallelGC -Xmx2G -cp "$HOME/.local/opt/tla2tools/tla2tools.jar:$HOME/.quint/apalache-dist-0.56.1/apalache/lib/apalache.jar" tlc2.TLC -deadlock -workers 2 -metadir "$watchdog_dir/states" watchdog.tla
```

The compiler uses a localhost Apalache server and requires sandbox access to bind its port. `quint compile` writes TLA+ to stdout; its `--out` option writes compiler JSON.
