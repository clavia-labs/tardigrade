import { useState, type ReactElement } from "react"

const columns = ["A", "B", "C"] as const
const rows = [1, 2, 3] as const
type Cell = `${typeof columns[number]}${typeof rows[number]}`
const cells: readonly Cell[] = rows.flatMap(row => columns.map(column => `${column}${row}` as Cell))

const evaluate = (cell: Cell, entries: Record<Cell, string>, visiting = new Set<Cell>()): number => {
  if (visiting.has(cell)) throw new Error("Circular reference")
  const next = new Set(visiting).add(cell)
  const expression = entries[cell].trim().replace(/^=/, "").toUpperCase()
  const tokens = expression.match(/[A-Z]+\d+|(?:\d+(?:\.\d*)?|\.\d+)(?:E[+-]?\d+)?|[()+*/-]|\S/g) ?? []
  let position = 0
  const primary = (): number => {
    const token = tokens[position++]
    if (token === "+") return primary()
    if (token === "-") return -primary()
    if (token === "(") {
      const value = sum()
      if (tokens[position++] !== ")") throw new Error("Expected closing parenthesis")
      return value
    }
    if (cells.includes(token as Cell)) return evaluate(token as Cell, entries, next)
    if (token === undefined || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:E[+-]?\d+)?$/.test(token)) throw new Error("Use numbers or cell references")
    return Number(token)
  }
  const product = (): number => {
    let value = primary()
    while (tokens[position] === "*" || tokens[position] === "/") {
      const operator = tokens[position++]
      const right = primary()
      value = operator === "*" ? value * right : value / right
    }
    return value
  }
  const sum = (): number => {
    let value = product()
    while (tokens[position] === "+" || tokens[position] === "-") {
      const operator = tokens[position++]
      const right = product()
      value = operator === "+" ? value + right : value - right
    }
    return value
  }
  if (expression === "") return 0
  const value = sum()
  if (position !== tokens.length || !Number.isFinite(value)) throw new Error("Invalid formula")
  return value
}

const display = (cell: Cell, entries: Record<Cell, string>): string => {
  if (entries[cell].trim() === "") return ""
  try { return String(evaluate(cell, entries)) } catch { return "#ERROR" }
}

export const AtomSpreadsheet = (): ReactElement => {
  const [entries, setEntries] = useState<Record<Cell, string>>({ A1: "2", B1: "= A1 * 2", C1: "= B1 + 1", A2: "", B2: "", C2: "", A3: "", B3: "", C3: "" })
  const [editing, setEditing] = useState<Cell>()
  const [selected, setSelected] = useState<Cell>("A1")
  return <figure className="atom-spreadsheet">
    <div className="spreadsheet-formula"><span className="spreadsheet-address">{selected}</span><span className="spreadsheet-fx" aria-hidden="true">ƒx</span><input aria-label={`${selected} formula`} value={entries[selected]} onChange={event => setEntries({ ...entries, [selected]: event.target.value })} spellCheck={false} /></div>
    <table aria-label="Editable spreadsheet. Select a cell to edit its value or formula.">
      <thead><tr><th aria-label="Row number" />{columns.map(column => <th scope="col" key={column}>{column}</th>)}</tr></thead>
      <tbody>{rows.map(row => <tr key={row}><th scope="row">{row}</th>{columns.map(column => { const cell: Cell = `${column}${row}`; return <td key={cell} data-selected={selected === cell} data-editing={editing === cell}>{entries[cell].trim().startsWith("=") && editing !== cell && <span className="spreadsheet-cell-formula" aria-hidden="true">{entries[cell]}</span>}<input aria-label={`${cell} value or formula`} value={editing === cell ? entries[cell] : display(cell, entries)} onFocus={() => { setSelected(cell); setEditing(cell) }} onBlur={() => setEditing(undefined)} onChange={event => setEntries({ ...entries, [cell]: event.target.value })} spellCheck={false} /></td> })}</tr>)}</tbody>
    </table>
  </figure>
}
