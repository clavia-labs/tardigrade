import { sandboxSequenceWith, sandboxLargeReplayWith } from "../sandbox.cases"

interface CelldTestEnv {
  readonly LOADER: WorkerLoader
}

const worker = {
  async fetch(request: Request, env: CelldTestEnv): Promise<Response> {
    const transport = new URL(request.url).searchParams.get("transport") ?? "replay"
    if (transport !== "replay" && transport !== "capability") {
      return new Response("unknown sandbox transport", { status: 400 })
    }
    return Response.json({ runtime: "celld", ...await sandboxSequenceWith(env.LOADER, transport),
      largeReplay: await sandboxLargeReplayWith(env.LOADER, 200_000) })
  }
} satisfies ExportedHandler<CelldTestEnv>

export default worker
