---
title: Fork a thread for an experiment
description: Copy a thread prefix through a checkpoint onto a new root.
route: /docs/fork-experiments
section: How To
order: 40
---

A fork copies one thread's event prefix through a checkpoint onto a new root. The destination records `ThreadForked` with `sourceThread`, `until`, and `forkedAt`. Later appends on the destination stay off the source log.

`until` is a 1-based sequence or an event `id`. A digit string such as `3` is sequence 3. `callId` is the fallback identity when `id` is absent.

```ts
const dest = await host.forkThread({ source: "root", until: "m1", name: "experiment" })
```

Omit `name` to let the host assign the destination id. Repeating the same named fork returns the existing destination. A destination that already has a different log is refused.

```bash
tdg fork root --until m1 --name experiment
tdg fork root --until 2
```

`POST /v1/actors/{instance}/threads/{thread}/fork` accepts `{ "until": "m1", "name": "experiment" }` and returns the destination coordinate.

The destination is a new root. Copied history drops the source `ThreadCreated` row because the destination already holds its own identity. The host leaves the destination quiet until later ingress, so an experiment can append from the frozen prefix.
