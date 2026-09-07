import type { Layer } from "effect"
import type { EventLog } from "@clavia/tardigrade-core/log"
import type { Router } from "@clavia/tardigrade-core/transport/router"
import type { Self } from "@clavia/tardigrade-core/runtime"
import type { ThreadAllocator } from "@clavia/tardigrade-core/actor/allocation"

// HostPorts supplies each thread's log, router, coordinate, and child allocator.
// layersFor may require them and must not provide them.
export type HostPorts = EventLog | Router | Self | ThreadAllocator

// ThreadEnv is the rest of an actor's R: what the host does not bind.
// Construction may require HostPorts; Layer.provideMerge discharges them.
export type ThreadEnv<R> = Layer.Layer<Exclude<R, HostPorts>, never, HostPorts>

