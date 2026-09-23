import type { ReactElement } from "react"

import excited from "../../../../../../assets/mascot/tardie-excited.svg"
import normal from "../../../../../../assets/mascot/tardie-normal.svg"
import thinkingPose from "../../../../../../assets/mascot/tardie-thinking.svg"
import usingTool from "../../../../../../assets/mascot/tardie-using-tool.svg"

export const TardigradeAgentIllustration = ({ working, thinking, done }: { readonly working: boolean; readonly thinking: boolean; readonly done: boolean }): ReactElement => (
  <img
    className="tool-agent-art"
    src={done ? excited : thinking ? thinkingPose : working ? usingTool : normal}
    alt={done ? "Tardie celebrating a completed turn" : thinking ? "Tardie thinking during a model call" : working ? "Tardie using a wrench during a tool call" : "Tardie"}
    width={570}
    height={410}
  />
)
