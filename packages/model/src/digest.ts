// sha256Of identifies serialized model configuration and registry snapshots (lock.test.ts, registry.test.ts).
export const sha256Of = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
}
