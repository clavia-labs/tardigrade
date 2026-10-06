import { Bird, TreeView } from "@phosphor-icons/react"
import { useId, type ReactElement } from "react"

const forms = {
  bird: { Icon: Bird, name: "a bird" },
  tree: { Icon: TreeView, name: "a file tree" },
} as const

type Labels = { readonly form: string; readonly layer: string; readonly shadow: string; readonly prisoner: string }

// CaveDiagram draws Plato's cave; form picks the object the carrier holds up, whose shadow the prisoner sees, and labels names the form, the carrier with the flame, the shadow, and the prisoner.
export const CaveDiagram = ({ form = "bird", labels }: { readonly form?: keyof typeof forms; readonly labels?: Labels }): ReactElement => {
  const outline = useId()
  const { Icon, name } = forms[form]
  return (
    <svg className="cave-diagram" viewBox="0 0 640 300" role="img" aria-label={`Plato's cave. A torch burns on a column. A carrier holds ${name} up on a stick behind a low wall, and its shadow falls on the cave wall, where a seated prisoner points at it.`}>
      <defs>
        {/* outline traces the edge of everything drawn inside it, so overlapping parts share one contour. */}
        <filter id={outline}>
          <feMorphology in="SourceAlpha" operator="erode" radius="1.5" result="inner" />
          <feComposite in="SourceAlpha" in2="inner" operator="out" result="edge" />
          <feFlood className="cave-outline-ink" />
          <feComposite in2="edge" operator="in" />
        </filter>
      </defs>
      <g className="cave-ink">
        <path d="M0 0H640V300H560C552 250 548 200 552 150C556 100 548 50 540 18C480 14 420 4 360 10S220 4 160 12 60 6 0 12Z" />
        <path d="M0 278H640V300H0Z" />
      </g>
      <path className="cave-flame" d="M48 94C40 82 44 62 56 50C56 60 60 66 64 66C60 48 70 30 86 14C82 30 86 40 90 46C94 42 96 38 98 34C102 48 104 60 100 72C98 84 92 94 82 94Z" />
      <path className="cave-rays" d="M102 62L582 96M102 68L582 128M101 74L582 160" />
      <ellipse className="cave-light" cx="592" cy="110" rx="24" ry="64" />
      <Icon className="cave-shape" x="571" y="90" size={42} weight="fill" />
      <g className="cave-object" filter={`url(#${outline})`}>
        <path d="M44 278V262H96V278ZM50 262V104H90V262ZM40 104V94H100V104Z" />
        <path d="M296 278L304 150H336L344 278Z" />
        <path className="cave-stick" d="M236 140V94" />
        <Icon className="cave-shape" x="212" y="50" size={48} weight="fill" />
        <g transform="translate(210 278)">
          <circle cx="6" cy="-150" r="11" />
          <path d="M-12-136C8-140 20-128 18-108L22-62 34-40H-30L-18-64C-22-96-24-126-12-136Z" />
          <path className="cave-limb" d="M12-128 26-170M-8-126-24-96-20-80M-12-42-34-2M14-42 30-2" />
        </g>
        <g transform="translate(366 278)">
          <circle cx="6" cy="-96" r="11" />
          <path d="M-10-82C8-84 16-70 14-50L10-20H-22C-24-50-22-76-10-82Z" />
          <path d="M-20-20C10-30 40-46 56-40L88-6 96-4V0H-20Z" />
          <path className="cave-limb" d="M6-72 34-82 62-94M-8-70-18-40-14-22" />
        </g>
      </g>
      {labels === undefined ? null : <g className="cave-labels">
        <text x="236" y="40" textAnchor="middle">{labels.form}</text>
        <path d="M134 222L94 198M166 222L192 198" />
        <text x="150" y="238" textAnchor="middle">{labels.layer}</text>
        <text className="cave-label-on-rock" x="596" y="192" textAnchor="middle">{labels.shadow}</text>
        <text x="372" y="164" textAnchor="middle">{labels.prisoner}</text>
      </g>}
    </svg>
  )
}
