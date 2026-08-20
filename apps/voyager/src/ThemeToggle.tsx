import { Moon, Sun } from "@phosphor-icons/react"
import type { ReactElement } from "react"

import { ICON_SIZE } from "./policy"
import { useTheme } from "./theme"

// ThemeToggle switches between the two designed themes from a persistent app-shell position.
export const ThemeToggle = (): ReactElement => {
  const { theme, toggle } = useTheme()
  return (
    <button
      type="button"
      className="icon-btn theme-toggle"
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to the light theme" : "Switch to the dark theme"}
      title="Toggle theme"
    >
      {theme === "dark" ? (
        <Moon size={ICON_SIZE} weight="light" aria-hidden="true" />
      ) : (
        <Sun size={ICON_SIZE} weight="light" aria-hidden="true" />
      )}
    </button>
  )
}
