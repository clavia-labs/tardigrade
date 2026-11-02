import { Select } from "@base-ui/react/select"
import { useRef, type ReactElement } from "react"

export const DropdownSelect = <Value extends string,>({ label, options, value, onChange }: {
  readonly label: string
  readonly options: readonly Value[]
  readonly value: Value
  readonly onChange: (value: Value) => void
}): ReactElement => {
  const container = useRef<HTMLDivElement>(null)
  return <div className="docs-select" ref={container}>
    <Select.Root value={value} onValueChange={next => { if (next !== null) onChange(next) }}>
      <Select.Trigger className="docs-select-trigger" aria-label={label}>
        <Select.Value />
        <Select.Icon><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg></Select.Icon>
      </Select.Trigger>
      <Select.Portal container={container}>
        <Select.Positioner className="docs-select-positioner" sideOffset={6} align="start" alignItemWithTrigger={false}>
          <Select.Popup className="docs-select-popup">
            <Select.List>
              {options.map(option => <Select.Item className="docs-select-item" key={option} value={option}>
                <Select.ItemText>{option}</Select.ItemText>
                <Select.ItemIndicator><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 8 3 3 7-7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg></Select.ItemIndicator>
              </Select.Item>)}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  </div>
}
