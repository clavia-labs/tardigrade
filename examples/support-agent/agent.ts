import type { Envelope } from "@flamecast/core"
import { createAgent, defaultPack, nudge } from "@flamecast/harness"
import { lookupInvoice } from "./native-tools"

const usedLookup = (log: ReadonlyArray<Envelope>): boolean =>
  log.some((event) => event.type === "ToolReturned" && event.name === "lookup_invoice")

const citeInvoice = nudge({
  id: "cite-invoice",
  when: usedLookup,
  text: "You read an invoice this turn. Name the invoice id in your answer."
})

export const supportAgent = createAgent({
  modules: [
    ...defaultPack({
      inference: {
        system:
          "You are a support agent. Use lookup_invoice for any question about an order. " +
          "Answer in plain text and keep answers short."
      },
      nativeTools: [lookupInvoice],
      budget: { defaultBudget: 24 }
    }),
    citeInvoice
  ]
})
