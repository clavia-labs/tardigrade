import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({ plugins: [react()], server: { proxy: {
  "/v1": process.env.CHAT_API_URL ?? "http://localhost:4242",
  "/healthz": process.env.CHAT_API_URL ?? "http://localhost:4242"
} } })
