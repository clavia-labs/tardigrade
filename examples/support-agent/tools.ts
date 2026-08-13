import { Effect } from "effect"
import type { Tool } from "@flamecast/harness"
import { invoiceForOrder } from "./invoices"

// A tool is a spec plus a handler. Both live with the tools module, so a code candidate can change
// the surface and implementation together.
//
// A handler that fails does not fail the turn: the tools module records the failure as
// `ToolReturned` with an `error`, and the model reads it and tries something else.

export const lookupInvoice: Tool = {
  spec: {
    name: "lookup_invoice",
    description: "Look up one invoice by its order id. Returns the total and the status.",
    inputSchema: {
      type: "object",
      properties: { orderId: { type: "string" } },
      required: ["orderId"]
    }
  },
  run: (input) =>
    Effect.sync(() => {
      const orderId = String((input as { readonly orderId?: unknown }).orderId ?? "")
      const found = invoiceForOrder(orderId)
      return found ?? { error: `no invoice for order ${orderId}` }
    })
}
