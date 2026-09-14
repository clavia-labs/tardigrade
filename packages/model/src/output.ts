// OutputCapability is what one configured endpoint promises about a declared contract. It is a
// union so a value cannot say two things at once: an endpoint that promises nothing has no
// tool-combination question to answer, and one that promises a native strict schema must say
// whether that schema may ride the same call as a tool list.
export type OutputCapability =
  | { readonly guarantee: "none" }
  | { readonly guarantee: "native"; readonly withTools: boolean }
