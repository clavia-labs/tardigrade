# Actors, threads, and placement

An actor is a behavior definition. A thread is one durable run of that actor. Every thread owns one event log, one workspace, and one recovery lifecycle.

## Storage boundaries

`ThreadEventStore` is the storage contract for one thread. Its operations do not accept a thread identifier because the store already has that identity. Host ingress, host reads, and reactors use the same store object, so append policy and read behavior cannot diverge between paths.

An actor directory indexes the threads created from one actor definition. It stores routing and query metadata. Event data remains in each thread's store.

The parent thread records `ChildCreated` before sending the child's first delivery. The child records `ThreadCreated` as the first event in its own log. The parent record owns discovery and carries the requested placement. The child record confirms its identity, parent, depth, and placement after the host applies its default.

## Durable Object layout

An actor definition gives the actor its name, methods, reactors, and model catalog. Each actor instance gets an Actor DO that owns its identity and thread tree as directory metadata. Root and child Thread DOs are physical peers. A parent-child edge records logical ancestry and does not nest one Durable Object inside another.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/actor-thread-layout-dark.svg">
  <img alt="The support-agent definition creates the user-42 actor instance, whose Actor DO indexes two root Thread DOs and one child Thread DO" src="../assets/actor-thread-layout-light.svg">
</picture>

## Child placement

A spawn may request `placement: "colocated" | "independent"`. The host uses `defaultChildPlacement` when the request omits it.

`colocated` means the child has its own execution stream and durable state within the parent host's placement boundary. On Bun, colocated threads use separate SQLite databases and runtimes in the same process. A Cloudflare Facets adapter can map colocated children to facets under one supervisor Durable Object.

`independent` means the host places the child's execution stream independently from the parent. Independent placement does not guarantee a different process or machine. The standard Cloudflare Durable Object adapter supports independent placement. A Bun host supports colocated placement. Each adapter exports its supported placements and default, and rejects an unsupported request.

## Platform layout

The Bun actor database is a directory and routing index. Thread databases live beside it under `<actor>.sqlite.threads/`. Each thread database contains that thread's event log and workspace. The model-facing workspace SQL surface remains separate from the event log. Effect SQL records migrations in `effect_sql_migrations` inside each physical database.

Cloudflare uses one Actor DO for the actor directory and one Thread DO per thread. Each Thread DO has its own SQLite database, heap, driver, and alarm lifecycle. The Actor DO reads its directory and asks each Thread DO for its log when it builds an actor-wide tree. Effect SQL applies each DO's pending schema migrations before the DO records its identity or opens its event store.

## Encrypted event stores

`storeFor` can wrap the `ThreadEventStore` for each Cloudflare thread. The wrapper can encrypt a plaintext object containing the event and a binding to the thread and event identity. It stores the random initialization vector and ciphertext beside the clear event identity required for event keys. Decryption verifies that the encrypted binding matches the current thread and the clear identity before returning the event.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/encrypted-thread-store-dark.svg">
  <img alt="A thread event passes through storeFor, is bound to its thread and event identity inside encrypted plaintext, stored as AES-GCM ciphertext, decrypted, and verified before use" src="../assets/encrypted-thread-store-light.svg">
</picture>

workerd does not support importing an HKDF key through `SubtleCrypto`, so the application must provision a raw AES-GCM key or use an external key service. workerd also ignores AES-GCM `additionalData`. The binding therefore lives inside the encrypted plaintext and is checked after decryption. A random 96-bit initialization vector is generated for every encrypted event.
