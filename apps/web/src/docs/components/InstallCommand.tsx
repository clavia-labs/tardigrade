import { useState, type ReactElement } from "react"
import { CheckIcon, CopyIcon, useCopy } from "../../ui/copy"
import { LiquidTabs } from "../../ui/LiquidTabs"

const managers = ["npm", "pnpm", "yarn", "bun"] as const
type Manager = typeof managers[number]

interface InstallCommandProps {
  readonly packageName: string
  readonly global?: boolean
  readonly defaultManager?: Manager
}

export const InstallCommand = ({ packageName, global: globalInstall = false, defaultManager = "bun" }: InstallCommandProps): ReactElement => {
  const commands = {
    npm: `npm install${globalInstall ? " -g" : ""} ${packageName}`,
    pnpm: `pnpm add${globalInstall ? " -g" : ""} ${packageName}`,
    yarn: `yarn ${globalInstall ? "global add" : "add"} ${packageName}`,
    bun: `bun add${globalInstall ? " -g" : ""} ${packageName}`,
  }
  const [manager, setManager] = useState<Manager>(defaultManager)
  const [copied, copy] = useCopy()
  return <div className="install-command-block">
    <LiquidTabs options={managers.map(value => ({ value, label: value }))} value={manager} onChange={setManager} label="Package manager" />
    <div className="install-snippet"><code><span>{manager}</span>{commands[manager].slice(manager.length)}</code><button type="button" onClick={() => void copy(commands[manager])} aria-label={copied ? "Command copied" : "Copy install command"}>{copied ? <CheckIcon /> : <CopyIcon />}</button></div>
  </div>
}
