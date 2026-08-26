import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { App } from "./App"
import "./styles.css"

const root = document.getElementById("root")
if (root === null) throw new Error("web: index.html has no #root element")

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
