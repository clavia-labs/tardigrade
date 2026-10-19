# Materialised state migrations

```text
saved checkpoint                     migrations.open
  plain schema-encoded JSON  ------> migrate shape -> decode -> initial
  ValueState                 ------> migrate shape ----------> initial
  DocumentState              ------> reference reader
                                           |
                             Merkle ------> read -> migrate shape -> initial
                             reducer -----> reopen current version
```

```text
index.ts          checkpoint format dispatch and cross-atom reads
inline.ts         encoded JSON and typed whole-value checkpoints
merkle.ts         reference format dispatch and Merkle conversion
legacy-nodes.ts   format-3 node import from older SQLite tables
```

Opening an old materialisation stages its replacement. Publication uses the caller's transaction with its event and checkpoint. Accepted work retains its original references until release; collection then reclaims unneeded materials. `read` resolves saved state without publishing a replacement.

Application `migrate` callbacks convert domain shapes. Core checkpoint envelopes and platform journal/recovery migrations remain with those packages. Reference codecs validate their own wire format.

[Migration properties](../../test/reducer/integration.ts) cover inline, whole-value and referenced state, mixed-format rollback, cold restart, retained selections and reclamation. The property runs on Bun SQLite and native Workerd SQLite.
