// frozenPlainData holds objects verified as deep-frozen plain data: array or plain-object prototypes, value properties only, no functions. Such an object cannot change, so a result computed from it once stays valid (validate.ts, decode.ts).
export const frozenPlainData = new WeakSet<object>()
