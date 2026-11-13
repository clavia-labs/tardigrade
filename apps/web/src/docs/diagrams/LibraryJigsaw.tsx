import type { ReactElement } from "react"
import { PuzzleGrid } from "../../site/artwork/PuzzleGrid"

export const LibraryJigsaw = (): ReactElement => <div className="library-jigsaw" aria-hidden="true">
  <PuzzleGrid rows={["110", "111"]} size={100} tabRatio={0.13} connectors="all" viewBox="-20 -20 340 240" />
</div>
