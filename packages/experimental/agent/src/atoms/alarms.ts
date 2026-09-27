import { atom, eventValue } from "@clavia/tardigrade-experimental-core"
import { alarmState } from "@clavia/tardigrade-experimental-packages"
import type { MessageReceived } from "../event"

// alarms interprets settled clock promises as reminder messages.
export const alarms = atom(get => {
  const items = get(alarmState)
  const effects = Object.fromEntries(items.filter(item => item.status === "rang" || item.status === "failed").map(({ alarm, status, error }) => [
    `alarm:${encodeURIComponent(alarm.alarmId)}`,
    eventValue({
      id: `deliver:${alarm.alarmId}`,
      event: {
        type: "MessageReceived", kind: "message", turnId: alarm.alarmId,
        text: status === "rang" ? `Alarm rang (data): ${JSON.stringify(alarm)}` : `Alarm failed (data): ${JSON.stringify({ alarm, error })}`,
      } satisfies MessageReceived,
    }),
  ]))
  return { items, effects }
})
