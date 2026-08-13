// The open envelope: the only event shape the core knows. One field is declared, and every other
// field rides along untyped.
//
// The shape is open on purpose. A reader written today reads a log written by a newer harness that
// emits event types it never met. An unknown event survives the read, and the folds that do not
// know it ignore it. This property is a tolerant read, and it is what lets an event alphabet grow
// without breaking an old log. A consumer that needs one event type narrows on `type`.
export type Envelope = { readonly type: string } & { readonly [key: string]: unknown }
