// When to read the student's work while myTA is watching. Every tick takes a tiny grayscale picture of the work window and compares it
// with the last one. A read is due when the work has changed since the last read and then sat still for a moment (a line was just
// finished), or, for someone who writes without ever stopping, when it has been changing for a while without a read. Nothing here calls
// the model; it only decides when the picture is worth sending.
import { CHANGE_THRESHOLD, MAX_UNREAD_MS, MIN_READ_GAP_MS, SETTLE_MS } from '../core/shared/constants';

/** A small grayscale picture, values 0..255, all the same size. */
export type Thumb = Uint8Array;

/** How much brighter or darker a pixel must get to count as changed: ink, not noise or a blinking cursor. */
export const PIXEL_STEP = 18;

/**
 * The share of pixels that clearly changed between two thumbnails, 0..1. A new line of handwriting is a small part of a big window, so
 * an average over the whole picture would hide it; counting the pixels that changed does not. Different sizes count as all changed.
 */
export function thumbDiff(a: Thumb | null, b: Thumb | null): number {
  if (!a || !b || a.length !== b.length || !a.length) return 1;
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > PIXEL_STEP) changed++;
  return changed / a.length;
}

export interface GateState {
  /** The thumbnail from the previous tick. */
  prev: Thumb | null;
  /** The thumbnail the last read was made from. */
  read: Thumb | null;
  /** When the picture last changed from one tick to the next. */
  changedAt: number;
  /** When the work first differed from the last read (null when it matches it). */
  unreadSince: number | null;
  lastReadAt: number;
}

export const initialGate = (): GateState => ({ prev: null, read: null, changedAt: 0, unreadSince: null, lastReadAt: 0 });

export interface GateDecision {
  read: boolean;
  why: string;
  state: GateState;
}

/**
 * One tick. `idleSec` is how long since the last keyboard, mouse or pen input anywhere (Windows' own count, whole seconds).
 * `busy` is true while a read is still running, so reads never overlap.
 */
export function gateTick(s: GateState, thumb: Thumb, now: number, idleSec: number, busy: boolean, threshold = CHANGE_THRESHOLD): GateDecision {
  const moved = thumbDiff(s.prev, thumb) > threshold;
  const unread = thumbDiff(s.read, thumb) > threshold;
  const state: GateState = {
    ...s,
    prev: thumb,
    changedAt: moved ? now : s.changedAt,
    unreadSince: unread ? (s.unreadSince ?? now) : null,
  };
  const no = (why: string): GateDecision => ({ read: false, why, state });
  if (busy) return no('a read is running');
  if (!unread) return no('nothing new since the last read');
  if (now - s.lastReadAt < MIN_READ_GAP_MS) return no('too soon after the last read');
  const stillFor = now - state.changedAt;
  // Settled: the picture stopped changing, and either the student's hand is off the pen/keyboard or it has been still a good while.
  const settled = !moved && stillFor >= SETTLE_MS && (idleSec >= 1 || stillFor >= SETTLE_MS * 2);
  const overdue = state.unreadSince !== null && now - state.unreadSince >= MAX_UNREAD_MS;
  if (!settled && !overdue) return no('still writing');
  return {
    read: true,
    why: settled ? `the work changed and then sat still for ${(stillFor / 1000).toFixed(1)} s (a line was just finished)` : 'the work has kept changing for a while',
    state: { ...state, read: thumb, unreadSince: null, lastReadAt: now },
  };
}

/** Marks a read made outside the gate (the first look, or a check the student asked for), so the same picture isn't read again. */
export function markRead(s: GateState, thumb: Thumb | null, now: number): GateState {
  return { ...s, read: thumb ?? s.read, prev: thumb ?? s.prev, unreadSince: null, lastReadAt: now };
}

/**
 * Whether the part of the picture under a box (0..1000 of the window, like the red square) changed: the student is editing the spot
 * that was marked. A little room around the box counts too, since a fix often runs past the old ink.
 */
export function regionChanged(a: Thumb, b: Thumb, box: [number, number, number, number], width = 160, height = 120): boolean {
  if (a.length !== b.length || a.length !== width * height) return true;
  const pad = 15;
  const y0 = Math.max(0, Math.floor(((box[0] - pad) / 1000) * height));
  const x0 = Math.max(0, Math.floor(((box[1] - pad) / 1000) * width));
  const y1 = Math.min(height - 1, Math.ceil(((box[2] + pad) / 1000) * height));
  const x1 = Math.min(width - 1, Math.ceil(((box[3] + pad) / 1000) * width));
  let changed = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (Math.abs(a[y * width + x] - b[y * width + x]) > PIXEL_STEP) changed++;
  return changed >= 2;
}

/** A change across a big share of the window (it scrolled, or a different page is showing): nothing marked on it is where it was. */
export const PAGE_CHANGE = 0.04;
