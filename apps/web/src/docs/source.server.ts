import cli from "@docs/references/cli.mdx?doc-source"
import concepts from "@docs/getting-started/concepts.mdx?doc-source"
import durability from "@docs/explanations/durability.mdx?doc-source"
import rlm from "@docs/examples/rlm.mdx?doc-source"
import bun from "@docs/platforms/bun.mdx?doc-source"
import celld from "@docs/platforms/celld.mdx?doc-source"
import cloudflare from "@docs/platforms/cloudflare.mdx?doc-source"
import quickstart from "@docs/getting-started/quickstart.mdx?doc-source"
import sdk from "@docs/references/sdk.mdx?doc-source"
import welcome from "@docs/start-here/Welcome.mdx?doc-source"
import why from "@docs/start-here/Why.mdx?doc-source"

const sources: Readonly<Record<string, string>> = {
  "references/cli.mdx": cli,
  "getting-started/concepts.mdx": concepts,
  "explanations/durability.mdx": durability,
  "examples/rlm.mdx": rlm,
  "platforms/bun.mdx": bun,
  "platforms/celld.mdx": celld,
  "platforms/cloudflare.mdx": cloudflare,
  "getting-started/quickstart.mdx": quickstart,
  "references/sdk.mdx": sdk,
  "start-here/Welcome.mdx": welcome,
  "start-here/Why.mdx": why
}

export const docSource = (source: string): string | undefined => sources[source]
