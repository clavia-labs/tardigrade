import { useId, type ReactElement, type ReactNode } from "react"
import { PostalStamp } from "../PostalStamp"

type Speaker = "socrates" | "you"

const names: Record<Speaker, string> = { socrates: "Socrates", you: "You" }

// SocratesPortrait draws a bald, bearded bust in a himation, in outline.
const SocratesPortrait = (): ReactElement => (
  <g className="notes-dialogue-portrait">
    <path className="fill" d="M12 74C14 60 22 54 42 54S70 60 72 74Z" />
    <path d="M22 60L50 74M30 57L56 74" />
    <path className="fill" d="M30 30C30 18 36 12 42 12S54 18 54 30C54 34 53 38 52 40H32C31 38 30 34 30 30Z" />
    <path d="M30 27C27 25 26 30 28 32M54 27C57 25 58 30 56 32" />
    <path className="fill" d="M31 36C30 44 32 52 37 56C39 58 41 57 42 58C43 57 45 58 47 56C52 52 54 44 53 36C50 39 46 38 42 38S34 39 31 36Z" />
    <path d="M36 44C38 47 40 48 42 48S46 47 48 44M38 39C40 37 44 37 46 39M36 19C40 17 44 17 48 19" />
    <path d="M42 26V33H40" />
    <circle className="ink" cx="37" cy="27" r="1.3" />
    <circle className="ink" cx="47" cy="27" r="1.3" />
  </g>
)

// YouPortrait draws a short-haired, clean-shaven bust in a t-shirt, in outline.
const YouPortrait = (): ReactElement => (
  <g className="notes-dialogue-portrait">
    <path className="fill" d="M12 74C14 60 22 54 42 54S70 60 72 74Z" />
    <path d="M34 55C37 60 47 60 50 55" />
    <path className="fill" d="M37 44H47V56H37Z" />
    <path className="fill" d="M30 30C30 18 36 13 42 13S54 18 54 30C54 42 49 49 42 49S30 42 30 30Z" />
    <path className="ink" d="M30 28C29 16 36 11 43 11C50 11 55 16 54 28C51 22 46 20 40 21C36 21 32 24 30 28Z" />
    <path d="M30 29C27 28 27 34 30 35M54 29C57 28 57 34 54 35" />
    <path d="M42 32V37H40M38 42C40 43.5 44 43.5 46 42" />
    <circle className="ink" cx="37" cy="31" r="1.3" />
    <circle className="ink" cx="47" cy="31" r="1.3" />
  </g>
)

// DialogueAvatar frames a speaker's portrait as a postage stamp, matching AuthorAvatar.
const DialogueAvatar = ({ speaker }: { readonly speaker: Speaker }): ReactElement => {
  const perforation = useId()
  const window = useId()
  return (
    <svg className="notes-dialogue-avatar" viewBox="-4 -4 92 92" aria-hidden="true">
      <defs>
        <clipPath id={window}><rect x="10" y="10" width="64" height="64" /></clipPath>
      </defs>
      <g transform={speaker === "socrates" ? "rotate(-4 42 42)" : "rotate(3 42 42)"}>
        <PostalStamp className="note-stamp-paper" id={perforation} x={2} y={2} width={80} height={80} />
        <g clipPath={`url(#${window})`}>
          {speaker === "socrates" ? <SocratesPortrait /> : <YouPortrait />}
        </g>
      </g>
    </svg>
  )
}

const Turn = ({ speaker, children }: { readonly speaker: Speaker; readonly children: ReactNode }): ReactElement => (
  <div className={`notes-dialogue-turn notes-dialogue-${speaker}`}>
    <DialogueAvatar speaker={speaker} />
    <p className="notes-dialogue-bubble"><span className="notes-dialogue-speaker">{names[speaker]}: </span>{children}</p>
  </div>
)

// Dialogue lays out Socrates and You turns as a chat; consecutive turns by one speaker show the avatar on the last.
export const Dialogue = ({ children }: { readonly children: ReactNode }): ReactElement => <div className="notes-dialogue">{children}</div>

export const Socrates = ({ children }: { readonly children: ReactNode }): ReactElement => <Turn speaker="socrates">{children}</Turn>

export const You = ({ children }: { readonly children: ReactNode }): ReactElement => <Turn speaker="you">{children}</Turn>
