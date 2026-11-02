import { Link } from "@tanstack/react-router"
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react"
import { Discord, Github, GuideIcon, Mark, MenuIcon } from "./icons"
import { ThemeToggle } from "./ThemeToggle"

const REPOSITORY = "https://github.com/clavia-labs/tardigrade"

const SiteFooter = (): ReactElement => {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <Link className="footer-brand" to="/" aria-label="Tardigrade home"><Mark /><span>Tardigrade</span></Link>
        <nav className="footer-links" aria-label="Footer navigation">
          <Link to="/docs/$" params={{ _splat: "agent" }}><GuideIcon />Agent</Link>
          <a href={REPOSITORY} rel="noreferrer" target="_blank"><Github />GitHub</a>
          <a href="https://discord.gg/Z74jwRxz4k" rel="noreferrer" target="_blank"><Discord />Discord</a>
          <ThemeToggle />
        </nav>
      </div>
    </footer>
  )
}

export const SiteShell = ({ children, pathname }: { readonly children: ReactNode; readonly pathname: string }): ReactElement => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const headerRef = useRef<HTMLElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const docs = pathname === "/" || pathname.startsWith("/docs") || pathname.startsWith("/notes")
  const closeMobileMenu = (): void => setMobileMenuOpen(false)

  useEffect(() => {
    if (!mobileMenuOpen) return

    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !headerRef.current?.contains(event.target)) setMobileMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return
      setMobileMenuOpen(false)
      menuButtonRef.current?.focus()
    }
    const closeAtDesktop = (): void => {
      if (window.innerWidth > 800) setMobileMenuOpen(false)
    }

    document.addEventListener("pointerdown", closeOutside)
    document.addEventListener("keydown", closeOnEscape)
    window.addEventListener("resize", closeAtDesktop)
    return () => {
      document.removeEventListener("pointerdown", closeOutside)
      document.removeEventListener("keydown", closeOnEscape)
      window.removeEventListener("resize", closeAtDesktop)
    }
  }, [mobileMenuOpen])

  if (docs) return <div className="docs-site">{children}</div>

  return <>
    <header className="site-header" ref={headerRef}>
      <nav className="nav-inner" aria-label="Main navigation">
        <div className="nav-brand-group">
          <div className="nav-brand">
            <Link className="brand" to="/" aria-label="Tardigrade home"><Mark /><span>Tardigrade</span></Link>
            <span className="brand-version" title="Current release" aria-label="Version 0.44.0">v0.44.0</span>
          </div>
          <Link className="guide-link" to="/docs" aria-current={docs ? "page" : undefined}>Docs</Link>
          <Link className="guide-link notes-link" to="/notes" aria-current={pathname.startsWith("/notes") ? "page" : undefined}>Notes</Link>
        </div>
        <div className="nav-actions">
          <a className="github-link" href={REPOSITORY} aria-label="Tardigrade on GitHub" rel="noreferrer" target="_blank"><Github /></a>
          <a className="discord-link" href="https://discord.gg/Z74jwRxz4k" aria-label="Tardigrade on Discord" rel="noreferrer" target="_blank"><Discord /></a>
          <div className="header-theme-toggle"><ThemeToggle /></div>
          <button className="mobile-menu-trigger" type="button" aria-controls="mobile-navigation" aria-expanded={mobileMenuOpen} ref={menuButtonRef} onClick={() => setMobileMenuOpen((open) => !open)}>
            <MenuIcon />
            <span>Menu</span>
          </button>
        </div>
      </nav>
      <div className="mobile-nav-panel" data-open={mobileMenuOpen} id="mobile-navigation" aria-hidden={!mobileMenuOpen} inert={!mobileMenuOpen ? true : undefined}>
        <nav className="mobile-nav-panel-inner" aria-label="Mobile navigation">
          <div className="mobile-nav-primary">
            <div className="mobile-nav-sections">
              <Link to="/docs" aria-current={docs ? "page" : undefined} onClick={closeMobileMenu}>Docs</Link>
              <Link className="notes-link" to="/notes" aria-current={pathname.startsWith("/notes") ? "page" : undefined} onClick={closeMobileMenu}>Notes</Link>
            </div>
          </div>
        </nav>
      </div>
    </header>

    {children}
    <SiteFooter />
  </>
}
