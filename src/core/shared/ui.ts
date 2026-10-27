import type { ActiveClass, ClassInfo } from './classes';

// What the overlay shows, sent from the main process whenever it changes, and what the overlay can ask for. Nothing private (the answer
// key, the private notes about the work) is ever part of it.

export type Mood = 'idle' | 'think' | 'alert' | 'cheer' | 'worry' | 'happy';

/**
 * asleep: only the monkey and "Call sprite" are on screen. reading: it is looking at the screen to find the problem. watching: it knows the
 * problem and reads the work as it changes. noProblem: it was called but couldn't find a problem to help with.
 */
export type Phase = 'asleep' | 'idle' | 'reading' | 'choosing' | 'watching' | 'noProblem';

export type BubbleKind = 'hello' | 'hint' | 'mistake' | 'copy' | 'cheer' | 'check' | 'info' | 'error' | 'video' | 'fixed';

/** Buttons a bubble can offer. */
export type BubbleAction = 'hint' | 'another' | 'video' | 'videoFor' | 'check' | 'retry' | 'problem' | 'ask' | 'readScreen' | 'hideMark' | 'pickProblem' | 'newProblem' | 'sleep' | 'setup' | 'watch';

export interface VideoCard {
  videoId: string;
  title: string;
  channel: string;
  /** "2:14" */
  at: string;
  why: string;
  url: string;
  /** True while Gemini is still finding the exact minute in the background. */
  refining: boolean;
}

export interface Bubble {
  id: number;
  kind: BubbleKind;
  title: string;
  text: string;
  /** Text still being checked by the leak guard: show a shimmer instead. */
  pending?: boolean;
  actions: { id: BubbleAction; label: string; arg?: string }[];
  video?: VideoCard;
  /** The exact piece of the student's own work a mistake is in, shown as written so they can find it at once. */
  quote?: string;
  /** Hide on its own after this many ms. */
  autoHideMs?: number;
}

/** The red square, in the overlay's own coordinates (DIPs from its top-left). */
export interface Mark {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
}

export interface UiState {
  phase: Phase;
  mood: Mood;
  /** Short name of the problem it is helping with ("chain rule"), "" when none. */
  problem: string;
  /** Where the problem came from. */
  source: 'screen' | 'upload' | 'photo' | 'typed' | null;
  busy: null | 'solve' | 'hint' | 'video' | 'check' | 'read';
  bubble: Bubble | null;
  mark: Mark | null;
  /** Bumped when a problem is solved, so the overlay throws confetti once. */
  cheer: number;
  solvedToday: number;
  hasKeys: boolean;
  hasCourse: boolean;
  /** Which window it is watching ("OneNote", "Untitled - Paint"), for the status line. */
  watching: string;
  /** The problem is code: text is shown exactly as written (no math symbols, since x^2 or -> mean something there). */
  code?: boolean;
}

export type OverlayAction =
  | { type: 'call' }
  | { type: 'sleep' }
  | { type: 'hint' }
  | { type: 'video'; concept?: string }
  | { type: 'check' }
  | { type: 'newProblem' }
  | { type: 'problem' }
  | { type: 'ask' }
  | { type: 'readScreen' }
  | { type: 'setup' }
  | { type: 'dismissBubble' }
  | { type: 'dismissMark' }
  | { type: 'watch'; url: string };

export interface MySprite {
  mode: 'monkey' | 'custom';
  /** The sticker as a PNG data URL (transparent background), when `mode` is "custom". */
  png?: string;
  /** A smooth cut-out sticker, or chunky pixel art to match the monkey. */
  style?: 'sticker' | 'pixel';
  name?: string;
  updatedAt: number;
}

export const DEFAULT_SPRITE: MySprite = { mode: 'monkey', updatedAt: 0 };

/** Where the student dragged the sprite, as distances from the right and bottom edges of the screen. */
export interface SpritePos {
  right: number;
  bottom: number;
}

/** What setup shows. Keys never come back to the renderer: only whether one is saved and its last four characters. */
export interface SettingsView {
  gemini: { saved: boolean; tail: string };
  serp: { saved: boolean; tail: string };
  model: string;
  solverModel: string;
  classes: ClassInfo[];
  activeClass: ActiveClass;
  hideFromCapture: boolean;
  showEverywhere: boolean;
  sprite: MySprite;
  hotkey: string;
}
