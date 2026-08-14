import { readFile } from "node:fs/promises"
import { join } from "node:path"

// The markdown gate. The house rules for prose are as mechanical as the ones for code, so they are
// checked the same way rather than left to review.
//
// The rule that motivates this tool: a paragraph is one line. Hard-wrapping prose at some column
// bakes one editor's width into the source, and every later edit reflows a whole block, so a
// one-word change reads as a five-line diff. Editors wrap for the reader.
//
// The second rule: a document states what is true now. Words that narrate the repository's history
// belong in commits and pull requests, where the reader is asking what changed.

const root = join(import.meta.dir, "..")

const files = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "docs/README.md",
  "docs/architecture.md",
  "docs/building-an-agent.md",
  "docs/codemode.md",
  "docs/concepts.md",
  "docs/events.md",
  "docs/evolution.md",
  "docs/modules.md",
  "docs/observability.md",
  "docs/orchestration.md",
  "docs/prior-art.md",
  "docs/runtimes.md"
]

interface Problem {
  readonly file: string
  readonly line: number
  readonly rule: string
  readonly detail: string
}

// A line that opens its own block rather than continuing the line above it.
const OPENS_BLOCK = /^(#{1,6} |[-*+] |\d+[.)] |> |\||```|~~~|<|\[[^\]]+\]:|---$|===)/

const isBlank = (line: string) => line.trim() === ""

// Prose that narrates the repository's own past or future instead of its present.
const HISTORY = [
  /\bpreviously\b/i,
  /\bused to\b/i,
  /\bno longer\b/i,
  /\bformerly\b/i,
  /\bdeprecated\b/i,
  /\bscheduled to change\b/i,
  /\bwill be replaced\b/i,
  /\bfor now\b/i,
  /^status:/i,
  /\bTODO\b/,
  /\bthis (page|document|section) (now|used)/i
]

const EMOJI = /[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|\u{FE0F}/u

// "not X, but Y" framing, where the contrast carries the meaning the sentence should carry.
const NOT_BUT = /\bnot\s+[^.,;:]{1,60},\s*but\b/i

// Text that names a rule or a symbol rather than using it. A document is allowed to quote the
// phrasing it forbids, so quoted spans and inline code drop out before the prose rules run.
const used = (line: string) => line.replace(/`[^`]*`/g, "").replace(/"[^"]*"/g, "")

const check = (file: string, text: string): ReadonlyArray<Problem> => {
  const problems: Array<Problem> = []
  const lines = text.split("\n")
  let fenced = false
  lines.forEach((line, index) => {
    const number = index + 1
    const add = (rule: string, detail: string) => problems.push({ file, line: number, rule, detail })
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      return
    }
    if (fenced) return
    const prose = used(line)
    if (EMOJI.test(line)) add("emoji", "documentation carries no emoji")
    if (line.includes("—") || line.includes("–")) add("dash", "use a comma, a colon, or a full stop")
    if (NOT_BUT.test(prose)) add("framing", `"not X, but Y" framing: ${line.trim().slice(0, 60)}`)
    if (/\s$/.test(line)) add("trailing-space", "the line ends in whitespace")
    for (const pattern of HISTORY) {
      if (pattern.test(prose)) {
        add("history", `documentation states the present: ${String(pattern)}`)
        break
      }
    }
    // A wrapped paragraph: this line continues the one above rather than opening a block.
    const previous = lines[index - 1]
    if (
      previous !== undefined &&
      !isBlank(line) &&
      !isBlank(previous) &&
      !OPENS_BLOCK.test(line) &&
      !OPENS_BLOCK.test(previous.trimStart()) &&
      !/^\s{2,}/.test(previous)
    ) {
      add("wrapped", "a paragraph is one line, so editors own the wrapping")
    } else if (
      previous !== undefined &&
      !isBlank(line) &&
      /^\s{2,}\S/.test(line) &&
      !OPENS_BLOCK.test(line.trimStart())
    ) {
      add("wrapped", "a list item is one line, so editors own the wrapping")
    }
  })
  return problems
}

const found: Array<Problem> = []
for (const file of files) {
  const text = await readFile(join(root, file), "utf8").catch(() => undefined)
  if (text === undefined) continue
  found.push(...check(file, text))
}

for (const problem of found) {
  console.log(`${problem.file}:${problem.line}: ${problem.rule}: ${problem.detail}`)
}
if (found.length > 0) {
  console.log(`\n${found.length} markdown problems`)
  process.exit(1)
}
console.log(`${files.length} markdown files pass`)
