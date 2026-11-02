import { useCallback, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react"

interface LiquidTabsProps<Value extends string> {
  readonly options: readonly { readonly value: Value; readonly label: ReactNode }[]
  readonly value: Value
  readonly onChange: (value: Value) => void
  readonly label: string
  readonly role?: "group" | "tablist"
  readonly id?: string
}

const PILL_SPRING = { stiffness: 260, damping: 28 }

const advanceSpring = (position: number, velocity: number, target: number, elapsed: number) => {
  const decay = PILL_SPRING.damping / 2
  const frequency = Math.sqrt(PILL_SPRING.stiffness - decay * decay)
  const offset = position - target
  const envelope = Math.exp(-decay * elapsed)
  const cosine = Math.cos(frequency * elapsed)
  const sine = Math.sin(frequency * elapsed)
  return {
    position: target + envelope * (offset * cosine + (velocity + decay * offset) / frequency * sine),
    velocity: envelope * (velocity * cosine - (decay * velocity + PILL_SPRING.stiffness * offset) / frequency * sine),
  }
}

export function LiquidTabs<Value extends string>({ options, value, onChange, label, role = "group", id }: LiquidTabsProps<Value>): ReactElement {
  const generatedId = useId()
  const prefix = id ?? generatedId
  const [ready, setReady] = useState(false)
  const group = useRef<HTMLDivElement>(null)
  const pill = useRef<HTMLSpanElement>(null)
  const buttons = useRef<Partial<Record<Value, HTMLButtonElement | null>>>({})
  const selected = useRef<Value>(value)
  const target = useRef<Value | undefined>(undefined)
  const baseWidth = useRef(0)
  const animation = useRef<Animation | undefined>(undefined)
  const sliding = useRef(false)
  const anchor = useRef({ x: 0, width: 0 })
  const spring = useRef({ pull: 0, velocity: 0, stretch: 0, stretchVelocity: 0, target: 0, frame: 0, time: 0 })

  const stopSpring = useCallback(() => {
    cancelAnimationFrame(spring.current.frame)
    spring.current = { pull: 0, velocity: 0, stretch: 0, stretchVelocity: 0, target: 0, frame: 0, time: 0 }
  }, [])

  const springTo = useCallback((pull: number) => {
    if (!pill.current || !baseWidth.current || sliding.current) return
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return
    if (animation.current?.playState === "running") return
    const state = spring.current
    state.target = pull
    if (state.frame) return
    state.time = performance.now()
    const tick = (now: number) => {
      const elapsed = Math.min((now - state.time) / 1000, .05)
      state.time = now
      const position = advanceSpring(state.pull, state.velocity, state.target, elapsed)
      const stretchTarget = Math.abs(state.target) * .8
      const stretch = advanceSpring(state.stretch, state.stretchVelocity, stretchTarget, elapsed)
      state.pull = position.position
      state.velocity = position.velocity
      state.stretch = stretch.position
      state.stretchVelocity = stretch.velocity
      const settled = Math.abs(state.pull - state.target) < .005 && Math.abs(state.velocity) < .02
        && Math.abs(state.stretch - stretchTarget) < .005 && Math.abs(state.stretchVelocity) < .02
      if (settled) {
        state.pull = state.target
        state.stretch = stretchTarget
      }
      const x = anchor.current.x + state.pull - (state.pull < 0 ? state.stretch : 0)
      if (pill.current) {
        pill.current.style.width = `${anchor.current.width + state.stretch}px`
        pill.current.style.transform = `translateX(${x}px) scaleY(${1 - state.stretch * .004})`
      }
      state.frame = settled ? 0 : requestAnimationFrame(tick)
    }
    state.frame = requestAnimationFrame(tick)
  }, [])

  const movePill = useCallback((name: Value, animate: boolean) => {
    const element = pill.current
    const button = buttons.current[name]
    if (!element || !button) return
    const changed = target.current !== name
    target.current = name
    const computed = getComputedStyle(element)
    const previous = computed.transform
    const previousWidth = computed.width
    stopSpring()
    animation.current?.cancel()
    sliding.current = false
    const initialized = baseWidth.current > 0
    if (!initialized) {
      baseWidth.current = button.offsetWidth
      element.style.width = `${baseWidth.current}px`
      setReady(true)
    }
    const x = button.offsetLeft
    const width = button.offsetWidth
    anchor.current = { x, width }
    const finalTransform = `translateX(${x}px)`
    element.style.width = `${width}px`
    element.style.transform = finalTransform
    if (!animate || !initialized || matchMedia("(prefers-reduced-motion: reduce)").matches) return

    if (!changed) {
      animation.current = element.animate([{ transform: previous, width: previousWidth }, { transform: finalTransform, width: `${width}px` }], { duration: 180, easing: "cubic-bezier(.22,1,.36,1)" })
      return
    }
    sliding.current = true
    const matrix = new DOMMatrixReadOnly(previous === "none" ? undefined : previous)
    const fromX = matrix.m41
    const fromWidth = parseFloat(previousWidth)
    const direction = Math.sign(x - fromX)
    const stretch = Math.min(Math.abs(x - fromX) * .1, 9)
    animation.current = element.animate([
      { transform: previous, width: previousWidth, offset: 0, easing: "cubic-bezier(.2,.8,.2,1)" },
      { transform: `translateX(${fromX - (direction < 0 ? stretch : 0)}px) scaleY(.94)`, width: `${fromWidth + stretch}px`, offset: .18, easing: "cubic-bezier(.22,1,.36,1)" },
      { transform: `translateX(${x + direction * 1.5}px) scaleY(.985)`, width: `${width * 1.015}px`, offset: .76, easing: "cubic-bezier(.2,.8,.2,1)" },
      { transform: finalTransform, width: `${width}px`, offset: 1 },
    ], { duration: 280 })
    animation.current.onfinish = () => { sliding.current = false }
  }, [stopSpring])

  const attractPill = useCallback((clientX: number) => {
    const button = buttons.current[selected.current]
    const container = group.current
    if (!button || !container) return
    const distance = clientX - container.getBoundingClientRect().left - button.offsetLeft - button.offsetWidth / 2
    const relativeDistance = distance / (button.offsetWidth * .75)
    const pull = 4 * relativeDistance * Math.exp((1 - relativeDistance * relativeDistance) / 2)
    springTo(pull)
  }, [springTo])

  useEffect(() => {
    const resize = () => movePill(target.current ?? selected.current, false)
    resize()
    const observer = new ResizeObserver(resize)
    if (group.current) observer.observe(group.current)
    for (const button of Object.values(buttons.current) as (HTMLButtonElement | null | undefined)[]) {
      if (button) observer.observe(button)
    }
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)")
    reducedMotion.addEventListener("change", resize)
    return () => {
      observer.disconnect()
      reducedMotion.removeEventListener("change", resize)
      animation.current?.cancel()
      stopSpring()
    }
  }, [movePill, stopSpring])

  useEffect(() => {
    if (selected.current !== value) {
      selected.current = value
      movePill(value, false)
    }
  }, [value, movePill])

  return <div ref={group} className="liquid-tabs" data-pill-ready={ready} role={role} aria-label={label} onPointerMove={event => {
    if (event.pointerType === "mouse" && matchMedia("(hover: hover) and (pointer: fine)").matches) attractPill(event.clientX)
  }} onPointerLeave={() => springTo(0)} onKeyDown={event => {
    if (role !== "tablist" || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
    event.preventDefault()
    const index = options.findIndex(option => option.value === selected.current)
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + options.length) % options.length
    const next = options[nextIndex]
    if (!next) return
    selected.current = next.value
    movePill(next.value, false)
    onChange(next.value)
    buttons.current[next.value]?.focus()
  }}>
    <span ref={pill} className="liquid-tab-indicator" aria-hidden="true" />
    {options.map(option => <button type="button" key={option.value} ref={button => { buttons.current[option.value] = button }}
      id={role === "tablist" ? `${prefix}-${option.value}-tab` : undefined}
      role={role === "tablist" ? "tab" : undefined}
      aria-controls={role === "tablist" ? `${prefix}-${option.value}-panel` : undefined}
      aria-selected={role === "tablist" ? value === option.value : undefined}
      aria-pressed={role === "group" ? value === option.value : undefined}
      tabIndex={role === "tablist" && value !== option.value ? -1 : 0}
      onFocus={event => { if (event.currentTarget.matches(":focus-visible")) movePill(selected.current, false) }}
      onClick={event => {
        selected.current = option.value
        onChange(option.value)
        movePill(option.value, event.detail !== 0)
      }}>{option.label}</button>)}
  </div>
}
