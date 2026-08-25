export const DEFAULT_LOADER_INTERVAL_MILLIS = 80

export const LOADER_FRAMES = ["◐", "◓", "◑", "◒"] as const

export interface LoaderOptions {
  readonly enabled?: boolean
  readonly intervalMillis?: number
  readonly write?: (text: string) => void
}

const clearLine = "\r\u001b[2K"

export const withLoader = async <A>(
  message: string,
  task: () => Promise<A>,
  options: LoaderOptions = {}
): Promise<A> => {
  const enabled = options.enabled ?? process.stdout.isTTY === true
  if (!enabled) return task()

  const write = options.write ?? ((text: string) => process.stdout.write(text))
  let frame = 0
  const render = () => {
    write(`${clearLine}  ${LOADER_FRAMES[frame % LOADER_FRAMES.length]} ${message}`)
    frame += 1
  }
  render()
  const timer = setInterval(render, options.intervalMillis ?? DEFAULT_LOADER_INTERVAL_MILLIS)
  try {
    return await task()
  } finally {
    clearInterval(timer)
    write(clearLine)
  }
}
