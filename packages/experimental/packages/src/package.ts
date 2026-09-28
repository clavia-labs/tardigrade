import type { AgentTool } from "./tool"

export interface Package<R = never> {
  readonly name: string
  readonly description: string
  readonly methods: readonly AgentTool<R>[]
  readonly toolNames?: Readonly<Record<string, string>>
}

// definePackage groups validated methods for direct tools and code execution.
export function definePackage<R>(definition: Package<R>): Package<R> {
  if (!/^[A-Za-z_$][\w$]*$/.test(definition.name)) throw new Error(`Invalid package name: ${definition.name}`)
  if (new Set(definition.methods.map(method => method.spec.name)).size !== definition.methods.length) throw new Error(`Duplicate method in ${definition.name}`)
  for (const [method, name] of Object.entries(definition.toolNames ?? {})) {
    if (!definition.methods.some(entry => entry.spec.name === method)) throw new Error(`Unknown method in ${definition.name}: ${method}`)
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) throw new Error(`Invalid tool name: ${name}`)
  }
  return definition
}

export type PackageRequirements<P> = P extends Package<infer R> ? R : never

// packageTools exposes explicit tool names or qualified defaults and retains qualified aliases for recorded calls.
export function packageTools<const P extends readonly Package<unknown>[]>(packages: P): readonly AgentTool<PackageRequirements<P[number]>>[] {
  if (new Set(packages.map(pkg => pkg.name)).size !== packages.length) throw new Error("Duplicate package name")
  const methods = packages.flatMap(pkg => pkg.methods.map(method => {
    const qualified = `${pkg.name}__${method.spec.name}`
    const name = pkg.toolNames?.[method.spec.name] ?? qualified
    return {
      ...method,
      aliases: [...(method.aliases ?? []), ...(name === qualified ? [] : [qualified])],
      spec: { ...method.spec, name, description: `${pkg.description}\n${method.spec.description}` },
    }
  }))
  const names = methods.flatMap(method => [method.spec.name, ...method.aliases])
  if (new Set(names).size !== names.length) throw new Error("Duplicate tool name or alias")
  return methods as readonly AgentTool<PackageRequirements<P[number]>>[]
}
