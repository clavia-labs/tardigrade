import { modelProviderModuleOf, type ModelProtocol } from "@clavia/tardigrade-model/providers/directory"

export const PROVIDER_REGISTRY_FILE = "generated/providers.ts"

// providerRegistrySource imports configured implementations once and dispatches by provider module (init-flow.test.ts).
export function providerRegistrySource(providers: Readonly<Record<string, { readonly protocol: ModelProtocol }>>): string {
  const modules = [...new Set(Object.entries(providers).map(([provider, config]) => modelProviderModuleOf(provider, config.protocol)))].sort()
  return [
    'import type { ModelBindingOptions } from "tardie/model"',
    ...modules.map((module, index) => `import { providerLayer as provider${index} } from "tardie/model/providers/${module}"`),
    "",
    '// providerLayer selects a configured implementation; tdg init and tdg setup generate this file.',
    'export const providerLayer: NonNullable<ModelBindingOptions["providerLayer"]> = options => {',
    "  const provider = options.provider",
    "  switch (provider) {",
    ...modules.map((module, index) => `    case "${module}": return provider${index}(options)`),
    '    default: throw new Error(`Provider ${provider} is absent from the generated registry; run tdg setup`)',
    "  }",
    "}",
    "",
  ].join("\n")
}
