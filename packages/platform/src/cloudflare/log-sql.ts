import module from "../shared/log-sql/vendor/sqlite3.wasm"
import m0 from "../shared/log-sql/vendor/callback-iiiii.wasm"
import m1 from "../shared/log-sql/vendor/callback-iiii.wasm"
import m2 from "../shared/log-sql/vendor/callback-iii.wasm"
import m3 from "../shared/log-sql/vendor/callback-iiiiii.wasm"
import m4 from "../shared/log-sql/vendor/callback-ii.wasm"
import m5 from "../shared/log-sql/vendor/callback-iiiij.wasm"
import m6 from "../shared/log-sql/vendor/callback-iij.wasm"
import m7 from "../shared/log-sql/vendor/callback-iiiiiii.wasm"
import { createLogQueryEngine } from "../shared/log-sql/engine"

export const cloudflareLogQueryEngine = createLogQueryEngine(async () => ({ module, callbacks: { iiiii: m0, iiii: m1, iii: m2, iiiiii: m3, ii: m4, iiiij: m5, iij: m6, iiiiiii: m7 } }))
