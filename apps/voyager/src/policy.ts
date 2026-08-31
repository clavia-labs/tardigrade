// The app's tuning numbers, in one place because a consumer must be able to see and set every
// policy value the app applies (AGENTS.md, "Design"). A screen imports the default and takes an
// override at the call site rather than reading a literal.

// RAIL_WIDTH is the thread rail width in pixels (flamecast-v6/apps/web/src/system.css, .chat-split).
export const RAIL_WIDTH = 236

// RAIL_COLLAPSED_WIDTH keeps the sidebar toggle reachable while its content is hidden; Rail accepts another width when embedded (Rail.tsx, Rail).
export const RAIL_COLLAPSED_WIDTH = 44

// RAIL_HEADER_HEIGHT is the single-row product header above the thread search; Rail accepts another height when embedded (Rail.tsx, Rail).
export const RAIL_HEADER_HEIGHT = 48

// The shared identity-row height in pixels. Each pane's title begins on the same horizontal datum,
// and each pane accepts another height when embedded in a tighter shell.
export const PANE_HEADER_HEIGHT = 64

// The size every icon renders at, in pixels (voyager-design-system.md, the icon policy). One number
// for the whole set, because a second size would be a second style.
export const ICON_SIZE = 15

// The event type pill's width in pixels. One shared width aligns every event summary, and Thread
// accepts another width when an embedding uses a different event vocabulary.
export const EVENT_STAMP_WIDTH = 164

// The event inspector's preferred width in pixels. It yields space to the trace when the viewport
// is narrow, and Thread accepts another width when its surrounding shell has a different measure.
export const EVENT_INSPECTOR_WIDTH = 480

// How often the event list re-reads the log after the stream is gone for good. The stream is the
// live path and this is the fallback (packages/client/src/stream.ts).
export const LOG_POLL_MS = 2000

// How many bars the window's density strip holds. Each bar counts the events whose time falls in
// its slice of the log's span, so the strip's resolution is this number and nothing else.
export const WINDOW_BUCKETS = 56

// The closest the two window handles come, as a fraction of the track. The handles cannot cross,
// and a window narrower than this shows no events while still being draggable back open.
export const WINDOW_MIN_GAP = 0.02

// How many events the window opens on when the log is longer than that. A reader arrives at the
// log's end, which is where a live run is, and drags left for the history.
export const DEFAULT_WINDOW_EVENTS = 50

// How many decimal places a window edge keeps in the URL. A drag reads the pointer to the pixel and
// a shared link needs only the position, so the fraction is rounded before it is written.
export const WINDOW_URL_DECIMALS = 4

// How far an arrow key moves a window handle, as a fraction of the track. A drag is the pointer's
// resolution and this is the keyboard's.
export const WINDOW_KEY_STEP = 0.02

// The density strip's height in pixels (mock.html, #track).
export const WINDOW_TRACK_HEIGHT = 34

// How many clock marks stand under the track. They divide the span evenly, first and last included.
export const WINDOW_MARKS = 4

// The height a bar takes as a percentage of the track: an empty bucket keeps WINDOW_BAR_MIN so the
// strip reads as a strip, and a bucket holding anything starts at WINDOW_BAR_BASE and grows with
// its share of the busiest bucket.
export const WINDOW_BAR_MIN = 6
export const WINDOW_BAR_BASE = 12

// How long the copy control shows the check before returning to the copy glyph, in milliseconds.
export const COPY_CONFIRM_MS = 1200

// The column the event type is padded to in copied text. The times, types, and summaries then line
// up in a plain-text editor, which is where the copied window is read.
export const COPY_TYPE_WIDTH = 16

// The longest summary string the app puts in the DOM. The visible ellipsis is the pane's, and this
// cap only keeps a megabyte-long code body out of a text node that shows one line of it.
export const SUMMARY_CHARS = 400

// The widest a field value grows in an opened row, in pixels (mock.html, .ev-val). The wrap is the
// browser's, so a long id or a long code line breaks on the glyph and the column keeps its measure.
export const FIELD_WIDTH = 660

// The maximum height of a collapsed expanded-field value in pixels. Thread accepts another height
// when an embedding has more or less vertical room.
export const FIELD_COLLAPSED_HEIGHT = 320

// The longest compact JSON a field value keeps on one line. Past it the value is indented, because
// a long object is read by its shape and a single line of it is read by nobody.
export const FIELD_INLINE_CHARS = 120

// How many nested JSON strings the trace reader decodes for display. A caller can pass another
// depth to summaryOf or fieldsOf when encoded JSON is part of the value rather than its container.
export const DEFAULT_JSON_PARSE_DEPTH = 4

// How near the list's end still counts as being at the end. Auto-scroll follows a live log only
// from the bottom, and a reader who has scrolled up is reading; this is the slack that a fractional
// scroll position is allowed to leave.
export const BOTTOM_SLACK_PX = 24
