export interface GraphNode {
  readonly id: string
  readonly package: string
  readonly layer: string
  readonly test: boolean
  readonly lines: number
  readonly source: string
  readonly external: string[]
}

export interface GraphEdge {
  readonly source: string
  readonly target: string
  readonly specifier: string
  readonly line: number
  readonly kind: "import" | "export" | "dynamic" | "require"
  readonly typeOnly: boolean
}

export interface PackageNode {
  readonly id: string
  readonly name: string
  readonly layer: string
  readonly dependencies: string[]
  readonly devDependencies: string[]
}

export interface Violation {
  readonly rule: string
  readonly message: string
  readonly source: string
  readonly target: string
  readonly line: number
}

export interface GraphData {
  readonly generatedAt: string
  readonly commit: string
  readonly nodes: GraphNode[]
  readonly edges: GraphEdge[]
  readonly packages: PackageNode[]
  readonly violations: Violation[]
  readonly cycles: string[][]
  readonly unresolved: { file: string; line: number; specifier: string }[]
}
