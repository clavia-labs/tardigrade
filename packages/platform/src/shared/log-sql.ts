// recallSelect confines caller SQL to one balanced subquery (packages/platform/test/scenarios/log/lifecycle.ts).
export function recallSelect(sql: string, privateNames: readonly string[]): string {
  const forbidden = new Set(["dbstat", "load_extension", "readfile", "writefile", "eval", ...privateNames].map(name => name.toLowerCase()))
  if (sql.includes("\0")) throw new Error("Recall SQL must not contain NUL")
  for (const [token] of sql.matchAll(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*/g)) {
    if (token.startsWith("--") || token.startsWith("/*")) continue
    const name = (/^['"`[]/.test(token) ? token.slice(1, -1).replace(/(['"`])\1/g, "$1") : token).toLowerCase()
    if (forbidden.has(name) || /^(sqlite_|pragma_|__cf_)/.test(name)) throw new Error("Recall SQL can only access the public events surface")
  }
  let depth = 0
  let quote: string | undefined
  let lineComment = false
  let blockComment = false
  let terminal: number | undefined
  for (let index = 0; index < sql.length; index++) {
    const character = sql[index]!
    const next = sql[index + 1]
    if (lineComment) { if (character === "\n") lineComment = false; continue }
    if (blockComment) { if (character === "*" && next === "/") { blockComment = false; index++ }; continue }
    if (quote) {
      if (character === quote) {
        if (next === quote && quote !== "]") index++
        else quote = undefined
      }
      continue
    }
    if (character === "-" && next === "-") { lineComment = true; index++; continue }
    if (character === "/" && next === "*") { blockComment = true; index++; continue }
    if (/\s/.test(character)) continue
    if (terminal !== undefined) throw new Error("Recall SQL accepts one SELECT statement")
    if (character === "'" || character === '"' || character === "`") quote = character
    else if (character === "[") quote = "]"
    else if (character === "(") depth++
    else if (character === ")") { if (--depth < 0) throw new Error("Recall SQL must be a balanced subquery") }
    else if (character === ";") {
      if (depth !== 0) throw new Error("Recall SQL accepts one SELECT statement")
      terminal = index
    }
  }
  if (quote || blockComment || depth !== 0) throw new Error("Recall SQL must be a complete subquery")
  const query = (terminal === undefined ? sql : sql.slice(0, terminal)).trim()
  if (!query) throw new Error("Recall SQL must not be empty")
  return `SELECT * FROM (\n${query}\n) LIMIT ?`
}
