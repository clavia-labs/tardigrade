import type { MessageContentPart, ObjectRef } from "tardie/agent"

export interface UploadPolicy {
  readonly maxUploadBytes: number
  readonly mediaTypes: ReadonlyArray<string>
}

const json = async <A>(response: Response): Promise<A> => {
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { error?: string } | undefined
    throw new Error(body?.error ?? `Upload service returned ${response.status}`)
  }
  return response.json() as Promise<A>
}

export const readUploadPolicy = (baseUrl: string, request: typeof fetch = fetch): Promise<UploadPolicy> =>
  request(`${baseUrl}/v1/objects`).then(json<UploadPolicy>)

// messageWithFiles uploads every attachment before publishing references (attachments.test.ts).
export const messageWithFiles = async (text: string, files: ReadonlyArray<File>, baseUrl: string, policy: UploadPolicy | undefined, request: typeof fetch = fetch) => {
  if (files.length === 0) return { text }
  if (policy === undefined) throw new Error("Upload policy is not available")
  for (const file of files) {
    if (!policy.mediaTypes.includes(file.type)) throw new Error(`${file.name}: unsupported file type`)
    if (file.size === 0) throw new Error(`${file.name}: file is empty`)
    if (file.size > policy.maxUploadBytes) throw new Error(`${file.name}: exceeds the ${policy.maxUploadBytes} byte upload limit`)
  }
  const content: MessageContentPart[] = text.length === 0 ? [] : [{ type: "text", text }]
  for (const file of files) {
    const { object } = await json<{ object: ObjectRef }>(await request(`${baseUrl}/v1/objects`, {
      method: "POST", headers: { "content-type": file.type }, body: file
    }))
    content.push({ type: "file", mediaType: file.type, filename: file.name, object })
  }
  return { content }
}
