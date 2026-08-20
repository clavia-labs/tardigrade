import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { App } from "./App"
import { applyTheme, chosenTheme } from "./theme"
import "./tun.css"

// The entry point. The token sheet resolves the system's preference on its own, so the only thing
// applied here is a choice the reader has already made, and it is applied before the first render
// rather than after it: a theme must not flash (src/tun.css, src/theme.ts).
const chosen = chosenTheme()
if (chosen !== undefined) applyTheme(chosen)

const root = document.getElementById("root")
if (root === null) throw new Error("voyager: index.html has no #root element")

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
