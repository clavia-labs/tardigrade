import cli from "@docs/cli.mdx?doc-source"
import concepts from "@docs/concepts.mdx?doc-source"
import rlm from "@docs/examples/rlm.mdx?doc-source"
import bun from "@docs/platforms/bun.mdx?doc-source"
import celld from "@docs/platforms/celld.mdx?doc-source"
import cloudflare from "@docs/platforms/cloudflare.mdx?doc-source"
import quickstart from "@docs/quickstart.mdx?doc-source"
import sdk from "@docs/sdk.mdx?doc-source"
import welcome from "@docs/Welcome.mdx?doc-source"
import why from "@docs/Why.mdx?doc-source"

const sources: Readonly<Record<string, string>> = {
  "cli.mdx": cli,
  "concepts.mdx": concepts,
  "examples/rlm.mdx": rlm,
  "platforms/bun.mdx": bun,
  "platforms/celld.mdx": celld,
  "platforms/cloudflare.mdx": cloudflare,
  "quickstart.mdx": quickstart,
  "sdk.mdx": sdk,
  "Welcome.mdx": welcome,
  "Why.mdx": why
}

export const docSource = (source: string): string | undefined => sources[source]
