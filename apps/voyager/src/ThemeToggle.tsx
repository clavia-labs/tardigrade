import { Moon, Sun } from "@phosphor-icons/react"
import type { ReactElement, ReactNode } from "react"

import { ICON_SIZE } from "./policy"
import { useTheme } from "./theme"

// ThemeToggle switches between the two designed themes from the shell position its caller owns.
export const ThemeToggle = ({
  className = "icon-btn",
  label
}: {
  readonly className?: string | undefined
  readonly label?: ReactNode
} = {}): ReactElement => {
  const { theme, toggle } = useTheme()
  return (
    <button
      type="button"
      className={className}
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to the light theme" : "Switch to the dark theme"}
      title="Toggle theme"
    >
      {theme === "dark" ? (
        <Moon size={ICON_SIZE} weight="light" aria-hidden="true" />
      ) : (
        <Sun size={ICON_SIZE} weight="light" aria-hidden="true" />
      )}
      {label}
    </button>
  )
}
