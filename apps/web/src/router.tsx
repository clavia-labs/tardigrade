import { Link, createRouter } from "@tanstack/react-router"
import type { ReactElement } from "react"

import { PuzzleGrid } from "./PuzzleGrid"
import { routeTree } from "./routeTree.gen"

const notFoundRows = ["10010011111010010", "10010010001010010", "11111010001011111", "00010010001000010", "00010011111000010"]

const NotFoundPage = (): ReactElement => (
  <main className="not-found-page">
    <div className="not-found-state">
      <PuzzleGrid className="pixel-404" rows={notFoundRows} />
      <h1>Page not found</h1>
      <Link to="/docs">Go to docs</Link>
    </div>
  </main>
)

export const getRouter = () => createRouter({ routeTree, scrollRestoration: true, defaultNotFoundComponent: NotFoundPage })

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
