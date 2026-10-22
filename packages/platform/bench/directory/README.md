# Supervisor directory oracle

This opt-in benchmark checks directory correctness and memory growth through the production Cloudflare actor and supervisor APIs in workerd. Run the driver with Node.js 24 or later. The default workload compares 128 and 2,048 historical threads with 96 KiB of initial-state payload per allocation and two pending threads in each case. The large journal has 4,098 seed records and approximately 200 MB of serialized history. It is expected to fail while the supervisor retains the entire directory.

```sh
bun run --cwd packages/platform bench:directory
bun run --cwd packages/platform bench:directory --mode=control
```

The candidate command exits zero only when both journal sizes complete every correctness check and stay within all configured memory limits. The control retains a full materialized directory and exits zero only when the large case exceeds a configured memory limit. A control runtime error, failed measurement, or changed seed prefix is a failure; an arbitrary exception does not qualify as reproducing the memory problem.

Each size is seeded in bounded transactions. Seeding writes the existing `ThreadRequested` and `ThreadRegistered` events directly, without generating family indexes or directory checkpoints. The runner destroys the seeding runtime and opens a new workerd process against the same persistent SQLite storage before measurement. A second process restart checks recovery after fresh allocations. This includes cold runtime initialization and index backfill in the measurements.

The candidate workload checks first, last, and distributed historical lookups; absence; reuse of a historical name without reprovisioning; completion of pending allocations; initial-state preservation; concurrent requests sharing a named allocation; one injected provisioning failure followed by a successful retry; the same child name under two parents; and cold reopen without repeating settled provisioning or losing a child's name claim. Historical threads represent existing registrations and are not reprovisioned by the fixture. Provisioning counters persist in each thread object across workerd restarts. The seed journal prefix is verified through a SHA-256 digest, record count, and byte count before and after the workload; new journal records may be appended.

The runner samples the user worker isolate's V8 `usedSize` and `backingStorageSize` through the inspector during each phase. After each phase it requests garbage collection and records retained heap with the runtime still open. A no-op worker request supplies event-loop turns while inspector collection completes. The measurements cover the worker and its active durable objects, including pending provisioning and the fixed fresh-allocation workload. Backing storage has a separate budget so moving a full directory into encoded buffers does not hide its retention. The measurements exclude the Node driver, seeding process, SQLite disk size, and source bundling. Sampled peak heap is a lower bound on the instantaneous peak; post-collection retained heap provides an additional check against history-sized retention.

Default limits are 96 MiB sampled peak heap, 32 MiB retained heap, 32 MiB backing storage, and 8 MiB retained heap growth between the small and large workloads. The retained value for each size is the maximum post-collection value across its phases. These are acceptance budgets, and do not claim an achieved bound. A timeout or inspector error fails the run. No correctness assertion is disabled when a memory limit is exceeded.

All workload and acceptance values are exported in `config.ts` and accepted as command-line overrides:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--mode` | `candidate` | Production supervisor or full-directory control |
| `--small` | `128` | Historical threads in the small journal |
| `--large` | `2048` | Historical threads in the large journal |
| `--payload-bytes` | `98304` | Initial-state padding bytes per historical allocation |
| `--pending` | `2` | Pending allocations in each journal |
| `--seed-batch` | `16` | Threads per seeding transaction and records per digest page |
| `--lookups` | `256` | Historical lookup operations per size |
| `--fresh` | `8` | Fresh root allocations per size, at least two |
| `--sample-ms` | `10` | Interval between heap samples |
| `--timeout-ms` | `120000` | Deadline per request and inspector command |
| `--poll-ms` | `25` | Pending-registration and collector polling interval |
| `--max-peak-mib` | `96` | Maximum sampled V8 heap usage |
| `--max-retained-mib` | `32` | Maximum post-collection heap usage |
| `--max-growth-mib` | `8` | Maximum large-minus-small retained heap growth |
| `--max-backing-mib` | `32` | Maximum sampled or post-collection backing storage |
| `--out` | `.experiments/directory-oracle/<timestamp>` | Bundle, phase measurements, and JSON report directory |

Every report records the configuration, whether it matches the default workload and budgets, source commit, checkout status, worker bundle and oracle source digests, and Node.js, Miniflare, workerd, and esbuild versions. A passing reduced workload or a run with relaxed limits establishes only that configuration's result. Use the default candidate and control workloads to assess the supervisor fix.

```sh
bun run --cwd packages/platform bench:directory --small=4 --large=16 --payload-bytes=1024 --lookups=4 --fresh=2
bun --bun node_modules/.bin/tsc --noEmit -p "$PWD/packages/platform/bench/directory/tsconfig.json"
```

The benchmark does not cover upgrades from `actor_directory` storage, checkpoint-format migration, or interrupted family-index backfill. Those scenarios require separate checks. The oracle remains outside the normal test gate so the production-size fixture can be run explicitly while developing the supervisor conversion.
