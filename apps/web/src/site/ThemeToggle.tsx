import { useEffect, useState, type ReactElement } from "react"

const MoonIcon = (): ReactElement => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15.2A8.5 8.5 0 0 1 8.8 4 8.5 8.5 0 1 0 20 15.2Z" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" /></svg>
)

const SunIcon = (): ReactElement => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" /></svg>
)

export const ThemeToggle = (): ReactElement => {
  const [dark, setDark] = useState(false)
  useEffect(() => setDark(document.documentElement.dataset.theme === "dark"), [])
  const toggle = (): void => {
    const nextDark = !dark
    const theme = nextDark ? "dark" : "light"
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem("tardigrade-theme", theme)
    setDark(nextDark)
  }
  return (
    <button className="theme-toggle" type="button" aria-label={`Use ${dark ? "light" : "dark"} mode`} title={`Use ${dark ? "light" : "dark"} mode`} aria-pressed={dark} onClick={toggle}>
      {dark ? <SunIcon /> : <MoonIcon />}
    </button>
  )
}
