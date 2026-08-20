import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// The build. The app is static: it reads one server over HTTP and holds no server of its own, so
// the output is a directory apps/server can serve at `/` (voyager-spec.md, build phase 4).
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true }
})
