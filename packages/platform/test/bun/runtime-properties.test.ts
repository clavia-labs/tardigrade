import { test } from "bun:test"
import { propertyCases } from "../properties/suite"

for (const [name, run] of Object.entries(propertyCases)) test(name, run)
