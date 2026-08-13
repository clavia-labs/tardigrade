// The fake data layer. A real agent reaches a database here; the point of the example is the
// harness around it, so the table is four rows in memory and the example runs with no service up.

export interface Invoice {
  readonly invoice: string
  readonly orderId: string
  readonly total: string
  readonly status: "paid" | "open" | "refunded"
}

const TABLE: ReadonlyArray<Invoice> = [
  { invoice: "INV-4182", orderId: "4182", total: "312.00", status: "paid" },
  { invoice: "INV-4183", orderId: "4183", total: "89.50", status: "open" },
  { invoice: "INV-4190", orderId: "4190", total: "1240.00", status: "open" },
  { invoice: "INV-4201", orderId: "4201", total: "45.25", status: "refunded" }
]

export const invoiceForOrder = (orderId: string): Invoice | undefined =>
  TABLE.find((row) => row.orderId === orderId)

// The order ids a reader can try. The stub model reads a question for one of these.
export const knownOrders: ReadonlyArray<string> = TABLE.map((row) => row.orderId)
