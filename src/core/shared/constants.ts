// Difficulty, as the answer key rates it.
export const DEFAULT_DIFFICULTY = 3;
export const MIN_DIFFICULTY = 1;
export const MAX_DIFFICULTY = 5;

// Models. Save & test keys in setup replaces these with ones the key actually has.
export const DEFAULT_MODEL = 'gemini-3.8-flash';
export const DEFAULT_SOLVER_MODEL = 'gemini-4-argon';
export const DEFAULT_RPM = 40;

// ---- When to read the student's work (see main/watcher.ts) ----
/** How often the work window is sampled for changes while myTA is watching. */
export const WATCH_TICK_MS = 700;
/** The picture must stay the same for this long after a change before it is read: the line is finished, not still being written. */
export const SETTLE_MS = 900;
/** Never two reads closer together than this. */
export const MIN_READ_GAP_MS = 2_500;
/** A read is due anyway after this long if the work changed and never sat still (someone writing non-stop). */
export const MAX_UNREAD_MS = 15_000;
/** The share of thumbnail pixels that must clearly change for the work to count as changed (about 12 of 160x120: one short word). */
export const CHANGE_THRESHOLD = 0.0006;
/** A wrong copy of the problem is only shown once this many reads in a row agree on it (a half-written copy always looks wrong). */
export const COPY_READS_TO_FLAG = 2;
/** How long a notes window must stay in front before tanrushu reads its problem by itself (not while flicking past windows). */
export const AUTO_READ_DELAY_MS = 900;
/** After a read of a notes window found no problem, tanrushu waits this long before reading that window again by itself. */
export const AUTO_READ_RETRY_MS = 45_000;
/** When the work stops matching the problem (the student moved to the next one), it reads the new one, but at most this often. */
export const REREAD_GAP_MS = 20_000;
/** With no problem on the page, a change to the page is read again by itself, at most this often. */
export const NO_PROBLEM_REREAD_MS = 8_000;
/** How long the cheer stays up after a problem is solved. */
export const CHEER_MS = 9_000;
/** The longest Hint, Video or Check may work before tanrushu gives up and says so (a button never stays dead). */
export const BUSY_LIMIT_MS = 60_000;
