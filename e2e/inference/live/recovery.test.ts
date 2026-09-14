import { liveSuite } from "./support/suite"
import { runTarget } from "./support/recovery"

liveSuite("Durable host recovery", runTarget)
