import { useId, type ReactElement } from "react"

export const WorldGlobe = ({ sketch = false }: { readonly sketch?: boolean }): ReactElement => {
  const id = useId()
  return (
  <svg className="world-globe" viewBox="46 46 228 228" role="img" aria-label="The world" aria-describedby={`${id}-description`}>
    <desc id={`${id}-description`}>A globe representing the systems and people outside the actor.</desc>
    <defs>
      <clipPath id={`${id}-clip`}><circle cx="160" cy="160" r="112" /></clipPath>
    </defs>
    {sketch ? <>
      <path className="globe-sketch-outline" d="M160 48C221 46 273 99 272 160C275 221 220 273 160 272C97 274 47 220 48 160C46 99 100 47 160 48Z" />
      <path className="globe-sketch-echo" d="M91 72C130 41 181 42 219 65M256 104C281 153 269 213 232 244M146 272C102 267 66 240 52 199" />
      <g className="globe-continents" clipPath={`url(#${id}-clip)`}>
        <path d="M49 119L61 112L65 101L78 95L80 85L93 79L99 81L104 77L110 78L116 75L124 81L126 91L137 97L130 109L119 114L117 126L108 129L102 140L105 149L115 155L113 162L103 155L94 148L86 143L82 131L73 127L65 133L57 129Z" />
        <path d="M114 166L122 162L132 168L138 177L147 182Q153 190 148 198L141 213L134 222L131 234L123 244L118 238L121 224L116 213L117 201L109 191L107 180Z" />
        <path d="M134 62L140 58L145 59L150 55L156 58L160 64L157 69L157 75L152 81L149 88L145 85L142 78L138 76L137 69Z" />
        <path d="M190 100L198 93L204 97L205 108L216 111L214 119L205 121L200 129L190 127L185 119L179 118L181 110Z" />
        <path d="M176 139L185 134L198 134L205 138L210 148L215 154L225 151L222 158L212 168L208 180L204 191L198 202L190 214L185 211L181 200L180 189L174 180L173 171L165 168L162 160L165 150L170 143Z" />
        <path d="M220 103L228 96L235 99L243 93L254 102L266 101L281 114L276 133L266 138L261 149L254 146L248 150L250 148L246 155L242 170L237 163L235 151L223 146L219 139L224 132L219 122Z" />
        <path d="M212 192L216 183L219 188L216 202L212 207Z" />
        <path d="M245 214L258 207L272 214L275 226L264 237L249 234L240 225Z" />
      </g>
    </> : <>
    <circle className="globe-sphere" cx="160" cy="160" r="112" />
    <g className="globe-grid" clipPath={`url(#${id}-clip)`}>
      <ellipse cx="160" cy="160" rx="28" ry="112" />
      <ellipse cx="160" cy="160" rx="54" ry="112" />
      <ellipse cx="160" cy="160" rx="80" ry="112" />
      <ellipse cx="160" cy="160" rx="100" ry="112" />
      <ellipse cx="160" cy="104" rx="91" ry="18" />
      <ellipse cx="160" cy="132" rx="107" ry="20" />
      <ellipse cx="160" cy="160" rx="112" ry="21" />
      <ellipse cx="160" cy="188" rx="107" ry="20" />
      <ellipse cx="160" cy="216" rx="91" ry="18" />
    </g>
    </>}
  </svg>
  )
}
