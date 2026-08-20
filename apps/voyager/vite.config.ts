import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// The build. The app is static: it reads one server over HTTP and holds no server of its own, so
// the output is a directory apps/server can serve at `/` (voyager-spec.md, build phase 4).

// The bundle, written down because effect and Schema now ship to the browser on purpose: the app
// reads the server through the derived client (packages/client) instead of a hand-written fetch
// wrapper, and a later regression needs a number to fail against.
//
//                        JS        JS gzipped
//   hand-written client  223.42 kB  70.40 kB
//   derived client       369.62 kB 118.07 kB
//
// Measured with `bun run build` on Bun 1.4.0 and Vite 8.2.2. The escape hatch, if the number ever
// stops being acceptable, is a zero-dependency client generated from the OpenAPI document the same
// declaration already produces (apps/server/src/contract.test.ts).
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true }
})
