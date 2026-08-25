import { replaySequenceWith } from "../sandbox.cases"

interface CelldTestEnv {
  readonly LOADER: WorkerLoader
}

const worker = {
  async fetch(_request: Request, env: CelldTestEnv): Promise<Response> {
    return Response.json({ runtime: "celld", ...await replaySequenceWith(env.LOADER) })
  }
} satisfies ExportedHandler<CelldTestEnv>

export default worker
