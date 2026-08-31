import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { App } from "./App"
import "./styles.css"

const savedTheme = window.localStorage.getItem("tardigrade-theme")
const initialTheme = savedTheme === "dark" || (savedTheme === null && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light"
document.documentElement.dataset.theme = initialTheme

const root = document.getElementById("root")
if (root === null) throw new Error("web: index.html has no #root element")

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
