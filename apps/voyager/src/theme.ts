import { useState } from "react"

// The theme. Both themes are designed and neither is the default: the token sheet resolves the
// system preference on its own, and this module records the reader's explicit choice as the
// [data-theme] attribute that overrides it (src/tun.css).

export type Theme = "light" | "dark"

// Where the choice is kept. It is the reader's, not the run's, so it lives in the browser and never
// on the wire.
export const THEME_KEY = "voyager.theme"

const isTheme = (value: unknown): value is Theme => value === "light" || value === "dark"

// chosenTheme is the reader's recorded choice, absent while they have made none and the system
// preference is still deciding.
export const chosenTheme = (): Theme | undefined => {
  if (typeof localStorage === "undefined") return undefined
  const stored = localStorage.getItem(THEME_KEY)
  return isTheme(stored) ? stored : undefined
}

const systemTheme = (): Theme =>
  typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"

// applyTheme writes the choice onto the document, which is the whole of the switch: every color is
// a token and the attribute chooses the token set.
export const applyTheme = (theme: Theme): void => {
  document.documentElement.dataset["theme"] = theme
}

// useTheme reports the theme in force and the flip. The first answer is the recorded choice, or the
// system's if there is none, so the toggle always moves the reader to the other theme rather than
// to whichever one the attribute happens to be missing.
export const useTheme = (): { readonly theme: Theme; readonly toggle: () => void } => {
  const [theme, setTheme] = useState<Theme>(() => chosenTheme() ?? systemTheme())
  return {
    theme,
    toggle: () => {
      const next: Theme = theme === "dark" ? "light" : "dark"
      setTheme(next)
      applyTheme(next)
      if (typeof localStorage !== "undefined") localStorage.setItem(THEME_KEY, next)
    }
  }
}
