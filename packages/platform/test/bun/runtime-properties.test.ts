import { test } from "bun:test"
import { propertyCases } from "../properties/suite"
import { RUNTIME_PROPERTY_TEST_TIMEOUT_MS } from "../properties/runtime/config"

for (const [name, run] of Object.entries(propertyCases)) test(name, run, RUNTIME_PROPERTY_TEST_TIMEOUT_MS)
