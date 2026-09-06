export const allocateChatThread = async (
  allocate: (name: string) => Promise<{ readonly thread: string }>,
  save: (thread: string) => void,
  name: string
): Promise<string> => {
  const coordinate = await allocate(name)
  save(coordinate.thread)
  return coordinate.thread
}
