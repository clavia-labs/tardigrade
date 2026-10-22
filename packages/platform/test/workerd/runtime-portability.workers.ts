import { test } from "vitest"
import { RUNTIME_PROPERTY_WORKER_TEST_TIMEOUT_MS } from "../properties/runtime/config"
import { propertyCases } from "../properties/suite"

for (const [name, run] of Object.entries(propertyCases)) test(`runtime portability: ${name}`, run, RUNTIME_PROPERTY_WORKER_TEST_TIMEOUT_MS)
