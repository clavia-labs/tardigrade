# SQLite WASM

The generated SQLite 3.54.1 JavaScript wrapper and WASM binary come from `@sqlite.org/sqlite-wasm@3.54.1-build1`. The wrapper preserves the upstream SQLite and Emscripten license notices. Its source ID is `555e07ef33f69a0957d24d8e555b702464a131d6f1607f4c3c1e4551e8e6ca76`.

`tools/vendor-log-sqlite.ts` verifies the upstream file hashes, replaces dynamic callback compilation with precompiled modules for the bridge's callback signatures, and accepts bootstrap configuration through the Emscripten module argument. The engine disables browser filesystem VFS installation and uses an in-memory connection for each query. Cloudflare imports precompiled modules; Bun compiles these same files on first use.

`bun install` generates the ignored assets from the pinned build dependency. Package assembly regenerates and includes them in the published package. Consumers use the shipped assets directly. Regenerate locally with:

```sh
bun run sqlite:generate
```
