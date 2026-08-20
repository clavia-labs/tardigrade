// The app's tuning numbers, in one place because a consumer must be able to see and set every
// policy value the app applies (AGENTS.md, "Design"). A screen imports the default and takes an
// override at the call site rather than reading a literal.

// The rail's width in pixels (mock.html, the aside). It is a number here because the layout
// measures against it.
export const RAIL_WIDTH = 320

// How often the rail re-reads GET /agents for the roster: the roots, their counts, and the totals.
// The server publishes no change feed for the listing, so the rail polls, and this is both the
// delay between a run changing and the rail saying so and the resolution of the age column.
export const ROSTER_POLL_MS = 2000

// How often the event list re-reads the log after the stream is gone for good. The stream is the
// live path and this is the fallback, so the interval matches the rail's (src/api.ts, stream).
export const LOG_POLL_MS = 2000

// The opacity a row drops to when the scrub sits before it. The row stays legible, so a reader sees
// what the agent did not know yet rather than losing it.
export const SCRUB_DIM = 0.4

// The widest a summary line grows before the ellipsis takes over, in pixels (mock.html, .ev-text).
// The cut is the browser's, so it lands on the glyph rather than on a character count.
export const SUMMARY_WIDTH = 680

// The longest summary string the app puts in the DOM. The visible ellipsis is SUMMARY_WIDTH's, and
// this cap only keeps a megabyte-long code body out of a text node that shows one line of it.
export const SUMMARY_CHARS = 400

// The widest a field value grows in an opened row, in pixels (mock.html, .ev-val). The wrap is the
// browser's, so a long id or a long code line breaks on the glyph and the column keeps its measure.
export const FIELD_WIDTH = 660

// The longest compact JSON a field value keeps on one line. Past it the value is indented, because
// a long object is read by its shape and a single line of it is read by nobody.
export const FIELD_INLINE_CHARS = 120

// How near the list's end still counts as being at the end. Auto-scroll follows a live log only
// from the bottom, and a reader who has scrolled up is reading; this is the slack that a fractional
// scroll position is allowed to leave.
export const BOTTOM_SLACK_PX = 24
