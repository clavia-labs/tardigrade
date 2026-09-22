// ComponentReadonly protects the outer value while preserving unknown and primitive types.
export type ComponentReadonly<T> = T extends (...args: never[]) => unknown ? T : T extends object ? Readonly<T> : T
