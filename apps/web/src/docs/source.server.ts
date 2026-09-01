import cli from "@docs/cli.mdx?doc-source"
import concepts from "@docs/concepts.mdx?doc-source"
import rlm from "@docs/examples/rlm.mdx?doc-source"
import quickstart from "@docs/quickstart.mdx?doc-source"

const sources: Readonly<Record<string, string>> = {
  "cli.mdx": cli,
  "concepts.mdx": concepts,
  "examples/rlm.mdx": rlm,
  "quickstart.mdx": quickstart
}

export const docSource = (source: string): string | undefined => sources[source]
