import { defineModule } from "../module"
import type { Nudge, NudgePlacement } from "../definition"

export interface NudgeOptions extends Omit<Nudge, "placement"> {
  readonly placement?: NudgePlacement
  readonly version?: string
}

export const nudge = (options: NudgeOptions) =>
  defineModule({
    id: `nudge:${options.id}`,
    version: options.version ?? "1",
    identity: { id: options.id, text: options.text, placement: options.placement ?? "tail" },
    setup: () => ({
      nudges: [
        {
          id: options.id,
          when: options.when,
          text: options.text,
          ...(options.placement === undefined ? {} : { placement: options.placement }),
          ...(options.nativeTools === undefined ? {} : { nativeTools: options.nativeTools }),
          ...(options.withdrawsNativeTools === undefined
            ? {}
            : { withdrawsNativeTools: options.withdrawsNativeTools })
        }
      ]
    })
  })
