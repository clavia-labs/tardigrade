import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const directory = dirname(fileURLToPath(import.meta.url))
const repository = resolve(directory, "../../../..")
const suffix = `${process.pid}`
const network = `tardigrade-celld-${suffix}`
const store = `tardigrade-celld-store-${suffix}`
const runtime = `tardigrade-celld-runtime-${suffix}`
const deployImage = `tardigrade-celld-deploy:${suffix}`

export const DEFAULT_CELLD_TEST_PORT = 14_251
export const DEFAULT_CELLD_TEST_TIMEOUT_MILLIS = 30_000
export const DEFAULT_CELLD_TEST_LOADED_WORKER_LIMIT = 1
export const DEFAULT_CELLD_TEST_IMAGE = "ghcr.io/denoland/celld:v0.3.0"
export const DEFAULT_CELLD_TEST_NODE_IMAGE = "docker.io/library/node@sha256:03eae3ef7e88a9de535496fb488d67e02b9d96a063a8967bae657744ecd513f2"
export const DEFAULT_CELLD_TEST_ESBUILD_VERSION = "0.28.1"
export const DEFAULT_CELLD_TEST_STORE_IMAGE = "quay.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e"
export const DEFAULT_CELLD_TEST_STORE_CLIENT_IMAGE = "quay.io/minio/mc@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727"

const container = "container"
const port = Number(process.env.TARDIGRADE_CELLD_PORT ?? DEFAULT_CELLD_TEST_PORT)
const timeoutMillis = Number(process.env.TARDIGRADE_CELLD_TIMEOUT_MILLIS ?? DEFAULT_CELLD_TEST_TIMEOUT_MILLIS)
const loadedWorkerLimit = Number(
  process.env.TARDIGRADE_CELLD_LOADED_WORKER_LIMIT ?? DEFAULT_CELLD_TEST_LOADED_WORKER_LIMIT
)
const celldImage = process.env.TARDIGRADE_CELLD_IMAGE ?? DEFAULT_CELLD_TEST_IMAGE
const nodeImage = process.env.TARDIGRADE_CELLD_NODE_IMAGE ?? DEFAULT_CELLD_TEST_NODE_IMAGE
const esbuildVersion = process.env.TARDIGRADE_CELLD_ESBUILD_VERSION ?? DEFAULT_CELLD_TEST_ESBUILD_VERSION
const storeImage = process.env.TARDIGRADE_CELLD_STORE_IMAGE ?? DEFAULT_CELLD_TEST_STORE_IMAGE
const storeClientImage = process.env.TARDIGRADE_CELLD_STORE_CLIENT_IMAGE ?? DEFAULT_CELLD_TEST_STORE_CLIENT_IMAGE

interface CommandResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

const command = async (args: ReadonlyArray<string>, accepted = [0]): Promise<CommandResult> => {
  const child = Bun.spawn([container, ...args], { stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  if (!accepted.includes(code)) {
    throw new Error(`${container} ${args.join(" ")} exited ${code}\n${stdout}${stderr}`.trim())
  }
  return { code, stdout, stderr }
}

const addressOf = async (name: string): Promise<string> => {
  const result = await command(["inspect", name])
  const inspected = JSON.parse(result.stdout) as ReadonlyArray<{
    readonly networks?: ReadonlyArray<{ readonly ipv4Address?: string }>
  }>
  const address = inspected[0]?.networks?.[0]?.ipv4Address?.split("/")[0]
  if (address === undefined || address.length === 0) throw new Error(`${name} has no IPv4 address`)
  return address
}

const waitForStore = async (address: string): Promise<void> => {
  const until = Date.now() + timeoutMillis
  let lastError = "no response"
  while (Date.now() < until) {
    const result = await command([
      "run", "--rm", "--network", network, "--entrypoint", "sh", storeClientImage, "-c",
      `mc alias set local http://${address}:9000 minio minio123 >/dev/null && mc mb --ignore-existing local/tardigrade`
    ], [0, 1])
    if (result.code === 0) return
    lastError = `${result.stdout}${result.stderr}`.trim()
    await Bun.sleep(250)
  }
  throw new Error(`object store was not ready within ${timeoutMillis}ms: ${lastError}`)
}

const waitForRuntime = async (): Promise<unknown> => {
  const until = Date.now() + timeoutMillis
  let lastError = "no response"
  while (Date.now() < until) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}`)
      const body = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body}`)
      return JSON.parse(body) as unknown
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : String(cause)
      await Bun.sleep(250)
    }
  }
  throw new Error(`Celld was not ready within ${timeoutMillis}ms: ${lastError}`)
}

const cleanup = async (): Promise<void> => {
  for (const name of [runtime, store]) {
    await command(["stop", "--time", "1", name], [0, 1])
    await command(["delete", name], [0, 1])
  }
  await command(["network", "delete", network], [0, 1])
  await command(["image", "delete", "--force", deployImage], [0, 1])
}

const main = async (): Promise<void> => {
  console.log(`celld runtime ${celldImage}`)
  console.log(`loaded worker limit ${loadedWorkerLimit}`)
  try {
    await command([
      "build", "--tag", deployImage, "--file", resolve(directory, "Dockerfile"),
      "--build-arg", `CELLD_IMAGE=${celldImage}`,
      "--build-arg", `NODE_IMAGE=${nodeImage}`,
      "--build-arg", `ESBUILD_VERSION=${esbuildVersion}`,
      repository
    ])
    await command(["network", "create", network])
    await command([
      "run", "--detach", "--name", store, "--network", network,
      "--env", "MINIO_ROOT_USER=minio", "--env", "MINIO_ROOT_PASSWORD=minio123",
      storeImage, "server", "/data"
    ])
    const storeAddress = await addressOf(store)
    await waitForStore(storeAddress)
    const common = [
      "--env", "AWS_ACCESS_KEY_ID=minio",
      "--env", "AWS_SECRET_ACCESS_KEY=minio123",
      "--env", "AWS_REGION=us-east-1",
      "--network", network
    ]
    await command([
      "run", "--rm", ...common,
      "--mount", `type=bind,source=${repository},target=/workspace,readonly`,
      "--workdir", "/workspace/platform/worker-loader/test/celld",
      deployImage, "deploy", ".", "--bucket", "s3://tardigrade",
      "--endpoint", `http://${storeAddress}:9000`, "--region", "us-east-1"
    ])
    await command([
      "run", "--detach", "--name", runtime, ...common,
      "--publish", `${port}:8080`,
      "--env", "CELLD_STORAGE_PROBE=0",
      "--env", "CELLD_WORKER_LOADER=LOADER",
      "--env", `CELLD_MAX_LOADED_WORKERS=${loadedWorkerLimit}`,
      deployImage, "--bucket", "s3://tardigrade", "--endpoint", `http://${storeAddress}:9000`,
      "--region", "us-east-1", "--listen", "0.0.0.0:8080",
      "--internal-listen", "127.0.0.1:8081"
    ])
    const actual = await waitForRuntime()
    const expected = {
      runtime: "celld",
      result: { result: [12, 10] },
      observed: [
        { ordinal: 0, value: 3 },
        { ordinal: 1, value: 6 },
        { ordinal: 2, value: 5 }
      ]
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`unexpected Celld result: ${JSON.stringify(actual)}`)
    }
    console.log("celld replay passed")
  } catch (cause) {
    for (const name of [runtime, store]) {
      const logs = await command(["logs", name], [0, 1])
      if (logs.code === 0 && (logs.stdout.trim().length > 0 || logs.stderr.trim().length > 0)) {
        console.error(`${logs.stdout}${logs.stderr}`.trim())
      }
    }
    throw cause
  } finally {
    await cleanup()
  }
}

await main()
