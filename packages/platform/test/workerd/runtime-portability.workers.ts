import { test } from "vitest"
import { propertyCases } from "../properties/suite"

for (const [name, run] of Object.entries(propertyCases)) test(`runtime portability: ${name}`, run)
