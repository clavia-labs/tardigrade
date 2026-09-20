# @clavia/tardigrade-alchemy

Alchemy binding for the tardigrade Cloudflare host.

The host resolves its objects through `env.ACTORS` and `env.THREADS` (platform/cloudflare/src/actor.ts, platform/cloudflare/src/thread.ts). This package states that pairing once, so a Worker deployed by alchemy binds both namespaces without restating the class names.

## Usage

```ts
import { tardigradeBindings } from "@clavia/tardigrade-alchemy"
import * as Cloudflare from "alchemy/Cloudflare"

const worker = yield* Cloudflare.Worker("Worker", {
  main: "./worker.ts",
  bindings: {
    ACTORS: tardigradeBindings().ACTORS,
    THREADS: tardigradeBindings().THREADS,
    TARDIGRADE_TOKEN: "local",
  },
})
```

Assign the bindings directly. Do not spread them into a larger object literal.

## The worker entry

The entry exports the classes the host defines:

```ts
import { defineWorkerHost, workerHttp } from "@clavia/tardigrade-cloudflare/worker"

const host = defineWorkerHost(actor)

export const { ActorDO, ThreadDO } = host
export default { fetch: workerHttp(host).fetch }
```

Pass `actorClassName` or `threadClassName` when the entry re-exports the classes under other names.

## Environment

The host reads its configuration from bindings. `TARDIGRADE_TOKEN` is required for protected routes, including local requests. This package binds the namespaces only.
