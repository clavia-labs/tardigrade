import { defineModule } from "../module"
import type { Nudge, NudgePlacement } from "../definition"

// The id is carried as its literal so the module id is one too. Two nudges in a pack are two
// modules, and `createAgent` rejects a duplicate module id at the type level, which it can only do
// against ids it can tell apart.
export interface NudgeOptions<Id extends string = string> extends Omit<Nudge, "placement" | "id"> {
  readonly id: Id
  readonly placement?: NudgePlacement
  readonly version?: string
}

export const nudge = <const Id extends string>(options: NudgeOptions<Id>) =>
  defineModule({
    id: `nudge:${options.id}` as const,
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
