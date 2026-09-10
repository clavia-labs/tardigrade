---
title: Resume a package from an external reply
description: Wake a parked code package after its native result becomes durable.
route: /docs/external-replies
section: How To
order: 30
---

Use `ExternalReplyReceived` when a package starts a native operation outside a Tardigrade child method and must wait for its durable result. The event is a host ingress notification for one `BlockedOn.awaiting` id after the receipt is durable. Construct it with `id` and `at`; transition metadata does not belong on this ingress event. It carries no result, does not complete an actor method, and does not start an agent turn.

The package owns the result contract. It checks durable native storage each time it runs, parks while the receipt is absent, and returns the retained result after the matching notification wakes it. Keep the awaiting id stable for the package call. `ctx.callId` includes the code execution and package-call position, so it separates distinct calls and survives replay.

```ts
import { Effect } from "effect"
import { Park } from "tardie/code/execution/errors"
import { definePackage } from "tardie/code"

declare const loadNativeReceipt: (id: string) => Promise<{ value: string } | undefined>

export const nativePackage = definePackage({
  name: "native",
  description: "Runs a native operation with a durable receipt",
  methods: {
    result: (_args, ctx) => Effect.gen(function* () {
      const replyId = `native:${ctx.callId}`
      const receipt = yield* Effect.promise(() => loadNativeReceipt(replyId))
      if (receipt === undefined) {
        return yield* Effect.fail(new Park({ callId: ctx.callId, awaiting: replyId }))
      }
      return receipt
    })
  }
})
```

The native callback or poller stores the complete receipt before it appends the notification to the receiving thread. Pass the event through the host's ordinary durable append boundary. Actor runtimes include `externalReplyKeys`, so a host using `actorRuntimeOf(actor).keyOf` derives `external-reply:<id>` without a local key override.

```ts
import { externalReplyReceived } from "tardie/core"

declare const retainNativeReceipt: (id: string, receipt: { value: string }) => Promise<void>
declare const appendThreadEvent: (
  thread: string,
  event: ReturnType<typeof externalReplyReceived>
) => Promise<void>

export const receiveNativeResult = async (
  thread: string,
  replyId: string,
  receipt: { value: string },
  at: number
) => {
  await retainNativeReceipt(replyId, receipt)
  await appendThreadEvent(thread, externalReplyReceived({ id: replyId, at }))
}
```

Different ids produce different keys and records. Redelivery of the same id is absorbed in that thread. An id describes one immutable logical reply and is scoped by the receiving thread's log; reuse across threads does not join their histories.

Append the notification only after the result or error receipt is durable. A retained notification keeps the package runnable, so an early notification can cause repeated checks of a result that is still absent. When the receipt is available, the executor records the package result under the existing package-call identity.

This contract does not make the native operation execute once. The integration must give submission, lookup, retry, and billing their own durable identities and policies. A crash between retaining the receipt and appending the notification is safe only when the callback is redelivered, a poller retries the append, or another durable recovery path supplies the same reply id.
