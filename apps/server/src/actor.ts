import type { Actor } from "@clavia/tardigrade-core/actor"
import {
  actor,
  agentMethods,
  agentsPackage,
  budget,
  budgetAuthority,
  caller,
  codeMode,
  compaction,
  fetchPackage,
  filesPackage,
  infer,
  outputValidateOnce,
  workspacePackage,
  type AgentCatalog,
  type ModelRef
} from "tardie"
import { RESERVED_ACTOR } from "@clavia/tardigrade-client/contract"


// The actor this build serves: the reactors it runs, and the projections it declares over the logs
// they write. Both halves belong together, because a projection is only meaningful to whoever knows
// what the events mean, and that is the assembly that emitted them. The platform holds the log and
// mounts what is declared here by name (packages/client/src/contract.ts, apiOf).

// The assembly, one for every thread: code mode with four packages in scope, plus the policy
// components. v1 runs this one assembly and forking is the customization path (apps-server-spec.md,
// "Explicitly out of scope for v1").
//
// outputValidateOnce makes the server's handling explicit when its run-time model configuration supplies no native type proof.
//
// What the four packages add up to is what this actor can reach. `agents` fans work out to children
// and `workspace` reads what a result spilled, both inside the log. `files` reads and writes under
// one root directory, the working directory of the process that booted, and `fetch` makes HTTP
// requests to any host. There is no shell: a shell cannot be scoped the way a root or an origin can,
// and this build has no place to ask an operator whether one command is allowed.
export interface AssemblyModelPolicy {
  readonly contextWindowTokens?: number | ((model: ModelRef | undefined) => number)
  readonly catalog?: AgentCatalog
}

export const UNCONFIGURED_MODEL: AssemblyModelPolicy = {}

const assemblyOf = (models: AssemblyModelPolicy = UNCONFIGURED_MODEL) =>
  actor({
    name: RESERVED_ACTOR,
    methods: agentMethods,
    components: [
      infer([
        budget([codeMode([
          agentsPackage(models.catalog === undefined ? {} : { catalog: models.catalog }),
          workspacePackage(),
          filesPackage(),
          fetchPackage()
        ])], { authority: caller() }),
        compaction(models.contextWindowTokens === undefined ? {} : { contextWindowTokens: models.contextWindowTokens }),
        outputValidateOnce
      ]),
      budgetAuthority()
    ]
  })

// builtInActor declares the built-in assembly and its callable interface together.
export const builtInActor = assemblyOf

// ServerR is what this assembly needs bound. It is read off the assembly rather than restated, so a
// package added above lands in the host's obligation and a host that binds nothing for it fails to
// compile (host.ts, layerThread).
export type ServerR = ReturnType<typeof assemblyOf> extends Actor<infer R> ? R : never
