// Everything myTA does, in one place, with no Electron in it (so the tests can drive it with fakes).
//
//   Call tanrushu → read the work window (and the problem the student uploaded, if any) → the hidden answer key
//   watching     → every tick, a tiny picture of the work window; when the work changed and then sat still, read it and, on a mistake,
//                  put the red square on it and say what to look at (never the answer)
//   Hint         → one hint toward the right direction, through the leak guard; pressing again comes at it from a new angle
//   Video        → the clip found in the background when the problem was solved, opened at the minute that explains the concept
//   Check my work→ a full check of the work as it is now
//   solved       → confetti and the day's count
import { LlmError, type LlmCtx } from '../core/ai/llmClient';
import { FALLBACK_CHECK } from '../core/ai/prompts';
import { solve as realSolve, type ProblemUpload, type SolveInput } from '../core/ai/solver';
import { AUTO_READ_RETRY_MS, NO_PROBLEM_REREAD_MS, REREAD_GAP_MS } from '../core/shared/constants';
import type { CourseTopics } from '../core/ai/syllabus';
import { locateMistake as realLocate, reviewWork as realReview, type ReviewArgs, type WorkReview } from '../core/ai/work';
import { checkMessage as realCheck, guardedTutorTurn as realHint, type GuardedTurn } from '../core/leak/guard';
import { deterministicLeak, normalize, plainMath, type LeakVerdict } from '../core/leak/deterministic';
import { clipUrl, clock, type VideoFinder } from '../core/serp/videoFinder';
import { BUSY_LIMIT_MS, CHEER_MS, COPY_READS_TO_FLAG, WATCH_TICK_MS } from '../core/shared/constants';
import type { Box, ChatMessage, HintLevel, ProblemCandidate, SolverResult, VideoMoment, WorkState } from '../core/shared/types';
import type { Bubble, BubbleAction, Mark, OverlayAction, UiState } from '../core/shared/ui';
import type { TutorTurnArgs } from '../core/ai/tutor';
import type { ScreenSource, Shot } from './capture';
import { fromCloseUp } from './captureMath';
import { gateTick, initialGate, markRead, PAGE_CHANGE, regionChanged, thumbDiff, type GateState } from './gate';
import type { WinInfo } from './win32';

export interface AiFns {
  /** `fast`: the quick model, a few seconds. `smart`: the stronger model, the careful key that replaces it. */
  solve: (ctx: LlmCtx, input: SolveInput, tier?: 'fast' | 'smart') => Promise<SolverResult>;
  review: (ctx: LlmCtx, a: ReviewArgs) => Promise<WorkReview>;
  hint: (ctx: LlmCtx, a: TutorTurnArgs) => Promise<GuardedTurn>;
  check: (ctx: LlmCtx, hidden: SolverResult, message: string) => Promise<{ verdict: LeakVerdict }>;
  /** Where the wrong piece is in a close-up of the work (0..1000 of the close-up), or null. */
  locate: (ctx: LlmCtx, closeUp: string, wrongPart: string) => Promise<Box | null>;
}

const realAi: AiFns = { solve: realSolve, review: realReview, hint: (c, a) => realHint(c, a), check: (c, h, m) => realCheck(c, h, m), locate: realLocate };

export interface TutorDeps {
  llm(): LlmCtx | null;
  hasSerpKey(): boolean;
  course(): CourseTopics | null;
  workWindow(): WinInfo | null;
  /** Whether the work in this window may be read now (tanrushu only watches where it is on screen). Defaults to always. */
  canWatch?(w: WinInfo): boolean;
  screen: ScreenSource;
  /** Seconds since the last keyboard, mouse or pen input anywhere. */
  idleSec(): number;
  /** Top-left of the overlay window in DIPs (the red square is drawn in its coordinates). */
  overlayOrigin(): { x: number; y: number };
  emit(s: UiState): void;
  openUrl(url: string): void;
  openSetup(): void;
  openProblem(): void;
  /** Opens the question box next to tanrushu (type, paste or drop the problem, or read the screen). */
  askProblem?(): void;
  solvedToday(): number;
  addSolved(): number;
  videos: VideoFinder;
  ai?: Partial<AiFns>;
  now?: () => number;
  tickMs?: number;
  /** How long Hint, Video or Check may work before it gives up (tests shorten it). */
  busyLimitMs?: number;
  log?: (msg: string) => void;
}

const pick = <T>(xs: T[], seed: number) => xs[Math.abs(seed) % xs.length];

/** The window's name for the status line: "Untitled - Paint" → "Paint", "Notes – OneNote" → "OneNote". */
export function appName(title: string): string {
  const parts = title.split(/\s[-–—|]\s/).map((p) => p.trim()).filter(Boolean);
  return (parts[parts.length - 1] || title || 'your notes').slice(0, 40);
}

/** The red square for a box on a shot, in the overlay's coordinates, with a little room around the writing. */
export function markFor(box: Box, shot: Pick<Shot, 'rectDip'>, origin: { x: number; y: number }, id: number, label: string): Mark {
  const r = shot.rectDip;
  // A little room so the square doesn't sit on the ink itself.
  const pad = 4;
  const [y0, x0, y1, x1] = box;
  return {
    id,
    label,
    x: Math.round(r.x + (x0 / 1000) * r.width - origin.x - pad),
    y: Math.round(r.y + (y0 / 1000) * r.height - origin.y - pad),
    width: Math.round(((x1 - x0) / 1000) * r.width + pad * 2),
    height: Math.round(((y1 - y0) / 1000) * r.height + pad * 2),
  };
}

/**
 * True if a label myTA shows by itself (the problem's name, a video's title or concept, a button) would give the answer away. Stricter than
 * the check on hints: a hint may name the method ("use the chain rule"), but a label that IS the answer, or part of it, is never shown,
 * because on a "which rule applies?" question the method's name is the answer.
 */
export function labelLeaks(text: string, hidden: SolverResult): boolean {
  if (!text.trim()) return false;
  if (deterministicLeak(text, hidden).leaks) return true;
  const t = normalize(text);
  const answer = normalize(hidden.finalAnswer);
  return t.length >= 3 && answer.length >= 3 && (answer.includes(t) || t.includes(answer));
}

/**
 * Whether two reads found the same problem: most of the words and numbers in the problem text are shared (the same problem transcribed
 * twice is never word for word the same). Different givens or a different question make it a different problem.
 */
export function sameProblem(a: Pick<SolverResult, 'problemText'>, b: Pick<SolverResult, 'problemText'>): boolean {
  // Pieces of the problem: words, and math written without spaces ("y=sin(3x^2)", "r1=2"), so "y = sin(3x²)" and "y=sin(3x^2)" match.
  const pieces = (t: string) => [
    ...new Set(
      plainMath(t)
        .toLowerCase()
        .replace(/\s*([=+\-*/^()<>])\s*/g, '$1')
        .replace(/\.(?=\s|$)/g, '')
        .split(/[\s,;:?!]+/)
        .filter((w) => w && !['a', 'an', 'the', 'of', 'for', 'if', 'in', 'and', 'to', 'is'].includes(w)),
    ),
  ];
  /** The share of the smaller list that the other one also has. */
  const shared = (x: string[], y: string[]) => {
    const ys = new Set(y);
    return x.filter((w) => ys.has(w)).length / Math.max(1, Math.min(x.length, y.length));
  };
  const x = pieces(a.problemText);
  const y = pieces(b.problemText);
  if (!x.length || !y.length) return false;
  // The math decides: the same wording with another expression or other given values ("R1=2" against "R1=3") is another problem.
  const isMath = (w: string) => /[\d=^()+*/<>]/.test(w);
  const mx = x.filter(isMath);
  const my = y.filter(isMath);
  if (mx.length && my.length) return shared(mx, my) >= 0.6 && shared(x, y) >= 0.4;
  return shared(x, y) >= 0.6;
}

/**
 * Whether the student's work ends with a correct final answer: the last line (or the last part of it, after "=" or "so") matches the
 * final answer or one of its accepted forms. Forms that also appear in the problem itself are ignored (they prove nothing).
 */
export function writesAnswer(workRead: string, hidden: Pick<SolverResult, 'finalAnswer' | 'answerForms' | 'problemText'>): boolean {
  const lines = workRead.split(/\s*\/\s*|\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines.at(-1);
  if (!last) return false;
  const tidy = (t: string) => normalize(t).replace(/[.,;:!]+$/, '').replace(/^(so|therefore|thus|answer|ans|final answer|=)+/, '');
  const problem = normalize(hidden.problemText);
  const forms = [hidden.finalAnswer, ...(hidden.answerForms ?? [])].map(tidy).filter((f) => f.length >= 2 && !problem.includes(f));
  const tails = [last, ...last.split(/=|→|⇒|\bso\b|\btherefore\b/i).slice(-1)].map(tidy).filter(Boolean);
  return forms.some((f) => tails.some((t) => t === f || (f.length >= 6 && t.includes(f))));
}

/** How much two boxes overlap (intersection over union), 0..1. */
export function overlap(a: Box, b: Box): number {
  const iy = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const ix = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const area = (q: Box) => (q[2] - q[0]) * (q[3] - q[1]);
  return inter / Math.max(1, area(a) + area(b) - inter);
}

export class TutorService {
  private ai: AiFns;
  private now: () => number;
  private log: (m: string) => void;

  private ui: UiState;
  private hidden: SolverResult | null = null;
  private upload: ProblemUpload | null = null;
  /** The question as the student typed it into the question box. */
  private typed = '';
  private which = '';
  private history: ChatMessage[] = [];
  private hintsGiven = 0;
  private work: WorkState = { status: 'unknown', observation: '', reviewedAt: 0 };
  private gate: GateState = initialGate();
  private reading = false;
  /** The box behind the red square, and the shot it was found on. */
  /** The square on screen: where it is drawn (`box`, after the close look) and the reviewer's first box for it (`coarse`, what later reads are matched against). */
  private markBox: { box: Box; coarse: Box; shot: Shot; id: number; label: string; edited: boolean } | null = null;
  private dismissedBoxes: Box[] = [];
  private copyStreak = 0;
  private noWorkStreak = 0;
  /** Reads in a row that said the work is on a different problem. */
  private differentStreak = 0;
  private checkingNew = false;
  private solved = false;
  /** Bumped on every new problem and on sleep: answers that arrive for an older one are dropped. */
  private epoch = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ids = 0;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  /** Gives up on a Hint, Video or Check that has been working for too long, so a button never stays dead. */
  private stuckTimer: ReturnType<typeof setTimeout> | null = null;
  private uploadSentToReview = false;
  /** The read of the problem that is running, so Hint, Video and Check can wait for it. */
  private readPromise: Promise<void> | null = null;
  /** Which window the problem was last read from, and when (tanrushu reads a new notes window by itself). */
  private readFrom: number | null = null;
  private readAt = 0;
  /** The problems on the page when it couldn't tell which one the student is on, and what they asked for meanwhile. */
  private candidates: ProblemCandidate[] = [];
  private pendingAction: 'hint' | 'video' | 'check' | null = null;
  /** What the last read saw: notes, problems, or nothing (for the "no question here" message). */
  private lastPageKind: SolverResult['pageKind'];

  constructor(private d: TutorDeps) {
    this.ai = { ...realAi, ...(d.ai ?? {}) };
    this.now = d.now ?? Date.now;
    this.log = d.log ?? (() => undefined);
    this.ui = {
      phase: 'idle',
      mood: 'idle',
      problem: '',
      source: null,
      busy: null,
      bubble: null,
      mark: null,
      cheer: 0,
      solvedToday: d.solvedToday(),
      hasKeys: !!d.llm(),
      hasCourse: !!d.course()?.topics.length,
      watching: '',
    };
  }

  state(): UiState {
    return this.ui;
  }

  /** For tests and the e2e harness: the private answer key. Never sent to a renderer. */
  answerKey(): SolverResult | null {
    return this.hidden;
  }

  private set(patch: Partial<UiState>): void {
    this.ui = { ...this.ui, ...patch, hasKeys: !!this.d.llm(), hasCourse: !!this.d.course()?.topics.length };
    this.d.emit(this.ui);
  }

  /** Re-sends the state (after a settings change). */
  refresh(): void {
    this.set({});
  }

  private bubble(b: Omit<Bubble, 'id' | 'actions'> & { actions?: Bubble['actions'] }): number {
    const id = ++this.ids;
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.set({ bubble: { actions: [], ...b, id } });
    if (b.autoHideMs) {
      this.hideTimer = setTimeout(() => {
        if (this.ui.bubble?.id === id) this.set({ bubble: null, mood: this.ui.phase === 'watching' ? 'idle' : this.ui.mood });
      }, b.autoHideMs);
    }
    return id;
  }

  /** Updates a bubble only if it is still the one on screen. */
  private updateBubble(id: number, patch: Partial<Bubble>): void {
    if (this.ui.bubble?.id === id) this.set({ bubble: { ...this.ui.bubble, ...patch } });
  }

  private errorBubble(e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    const auth = e instanceof LlmError && (e.kind === 'auth' || e.kind === 'model' || e.kind === 'quota');
    this.bubble({
      kind: 'error',
      title: auth ? 'I need a working Gemini key' : 'Something went wrong',
      text: auth ? msg : `${msg} Try again in a moment.`,
      actions: auth ? [{ id: 'setup', label: 'Open setup' }] : [{ id: 'retry', label: 'Try again' }],
    });
    this.set({ mood: 'worry', busy: null });
  }

  /** Marks Hint, Video or Check as working, with a time limit: past it, the student is told and can try again. */
  private startBusy(kind: 'hint' | 'video' | 'check', title: string): number {
    this.set({ busy: kind, mood: 'think' });
    if (this.stuckTimer) clearTimeout(this.stuckTimer);
    this.stuckTimer = setTimeout(() => {
      this.stuckTimer = null;
      if (this.ui.busy !== kind) return;
      this.log(`${kind} took too long`);
      this.set({ busy: null, mood: 'worry' });
      this.bubble({ kind: 'error', title: 'That took too long', text: "I didn't get an answer in time. Try again in a moment.", actions: [{ id: kind, label: 'Try again' }] });
    }, this.d.busyLimitMs ?? BUSY_LIMIT_MS);
    return this.bubble({ kind: kind === 'video' ? 'video' : kind === 'check' ? 'check' : 'hint', title, text: '', pending: true });
  }

  private endBusy(kind: 'hint' | 'video' | 'check'): void {
    if (this.ui.busy !== kind) return;
    if (this.stuckTimer) clearTimeout(this.stuckTimer);
    this.stuckTimer = null;
    this.set({ busy: null });
  }

  /** A second tap on a button that is still working: show that it is (never a tap that does nothing). */
  private stillWorking(title: string): void {
    if (!this.ui.bubble?.pending) this.bubble({ kind: 'info', title, text: 'Still working on it. One moment.', pending: true });
  }

  // ---------------- actions from the overlay ----------------

  async act(a: OverlayAction | { type: BubbleAction; arg?: string }): Promise<void> {
    switch (a.type) {
      case 'call':
        // Tapping tanrushu (or the hotkey): wake it if it's napping, otherwise say hello and offer what it can do.
        if (this.ui.phase === 'asleep') return this.wake();
        return this.wave();
      case 'retry':
      case 'readScreen':
      case 'newProblem':
        // Read the problem again, from the screen (whatever was uploaded or typed before is dropped).
        if (this.ui.phase === 'reading') return;
        return this.setProblem(null, '', 'screen');
      case 'ask':
        return this.d.askProblem ? this.d.askProblem() : this.setProblem(null, '', 'screen');
      case 'pickProblem':
        return this.pickProblem('arg' in a && a.arg ? a.arg : '');
      case 'sleep':
        return this.sleep();
      case 'hint':
      case 'another':
        return this.hint();
      case 'video':
      case 'videoFor':
        return this.video('concept' in a ? a.concept : 'arg' in a ? a.arg : undefined);
      case 'check':
        return this.check();
      case 'problem':
        return this.d.openProblem();
      case 'setup':
        return this.d.openSetup();
      case 'dismissBubble':
        if (this.hideTimer) clearTimeout(this.hideTimer);
        return this.set({ bubble: null, mood: 'idle' });
      case 'dismissMark':
      case 'hideMark':
        if (this.markBox) this.dismissedBoxes.push(this.markBox.coarse);
        this.markBox = null;
        return this.set({ mark: null });
      case 'watch':
        return this.d.openUrl('url' in a && a.url ? a.url : (this.ui.bubble?.video?.url ?? ''));
    }
  }

  /** A tap on tanrushu while awake: a friendly hello and what it can do. */
  private wave(): void {
    const reading = this.ui.phase === 'reading';
    this.bubble({
      kind: 'hello',
      title: "I'm here!",
      text: reading
        ? "I'm reading your problem. Pick what you need and I'll do it as soon as I've read it."
        : this.hidden
          ? `Watching your work on ${this.ui.problem || 'this problem'}. What do you need?`
          : 'What do you need? Pick one below.',
      actions: this.helpActions(),
      autoHideMs: 8000,
    });
    this.set({ mood: 'happy' });
  }

  /** Wakes tanrushu from a nap and reads the problem on screen. */
  private wake(): void {
    this.set({ phase: 'idle', mood: 'happy' });
    void this.call(undefined, true);
  }

  /** How the student can give the problem: the question box when there is one, else the upload window. */
  private giveProblemActions(): Bubble['actions'] {
    return this.d.askProblem ? [{ id: 'ask', label: 'Type the question' }] : [{ id: 'problem', label: 'Upload problem' }];
  }

  private helpActions(): Bubble['actions'] {
    return [
      { id: 'hint', label: 'Hint' },
      { id: 'video', label: 'Video' },
    ];
  }

  /** The problem came from the problem window: an uploaded file or a photo, and maybe which problem it is. */
  async setProblem(upload: ProblemUpload | null, which: string, source: 'upload' | 'photo' | 'screen' | 'typed', typed = ''): Promise<void> {
    this.upload = upload;
    this.typed = typed.trim().slice(0, 4000);
    this.which = which.trim();
    return this.call(source);
  }

  /**
   * The notes window in front changed (tanrushu just appeared on it, or the student switched to another notes window): read its problem
   * on its own, without waiting to be asked, so the help buttons are ready when they're pressed.
   */
  autoRead(win: WinInfo): void {
    if (this.ui.phase === 'asleep' || this.ui.phase === 'reading' || this.ui.phase === 'choosing' || !this.d.llm()) return;
    // A problem the student gave by hand (uploaded or typed) stays until they ask for a new one.
    if (this.upload || this.typed) return;
    if (this.readFrom === win.hwnd && (this.hidden || this.now() - this.readAt < AUTO_READ_RETRY_MS)) return;
    void this.call(undefined, true);
  }

  // ---------------- finding the problem ----------------

  /**
   * Reads the problem (from the screen, or what the student uploaded or typed) and starts watching the work. `quiet` is for the reads
   * tanrushu starts on its own: no speech bubbles, only the status line, unless something needs the student (a key that doesn't work).
   */
  async call(source?: 'upload' | 'photo' | 'screen' | 'typed', quiet = false): Promise<void> {
    const p = this.readProblem(source, quiet);
    this.readPromise = p;
    try {
      await p;
    } finally {
      if (this.readPromise === p) this.readPromise = null;
    }
  }

  private async readProblem(source: 'upload' | 'photo' | 'screen' | 'typed' | undefined, quiet: boolean): Promise<void> {
    const epoch = this.reset();
    const ctx = this.d.llm();
    if (!ctx) {
      this.set({ phase: 'noProblem', mood: 'worry' });
      this.bubble({ kind: 'error', title: 'Hi! I need a Gemini key first', text: 'Add your Gemini API key in setup and I can start helping.', actions: [{ id: 'setup', label: 'Open setup' }] });
      return;
    }
    const src = source ?? (this.typed ? 'typed' : this.upload ? 'upload' : 'screen');
    const win = this.d.workWindow();
    this.readFrom = win?.hwnd ?? null;
    this.readAt = this.now();
    this.set({ phase: 'reading', mood: 'think', busy: 'solve', source: src, problem: '', watching: win ? appName(win.title) : this.ui.watching });
    if (!quiet) this.bubble({ kind: 'info', title: 'Let me take a look…', text: this.typed ? 'Reading your question.' : this.upload ? `Reading ${this.upload.name}.` : 'Reading the problem on your screen.', pending: true });

    let shot: Shot | null = null;
    try {
      shot = win ? await this.d.screen.shot(win, 'read') : null;
    } catch (e) {
      this.log(`capture failed: ${String(e)}`);
    }
    if (epoch !== this.epoch) return;
    // A read tanrushu started by itself, and the notes window was no longer in front when the picture was taken: the picture shows
    // whatever covered it, so it is dropped, and the window is read again when it is back in front.
    if (quiet && shot && win && !this.upload && !this.typed && this.d.canWatch && !this.d.canWatch(win)) {
      this.readFrom = null;
      this.set({ phase: 'idle', mood: 'idle', busy: null });
      return;
    }
    if (!shot && !this.upload && !this.typed) {
      this.set({ phase: 'noProblem', mood: 'worry', busy: null });
      if (!quiet)
        this.bubble({
          kind: 'error',
          title: "I can't see your work",
          text: 'Click on the window you are writing in, then tap Look again. Or upload a photo or PDF of the problem.',
          actions: [{ id: 'retry', label: 'Read again' }, ...this.giveProblemActions()],
        });
      return;
    }

    const input: SolveInput = { screen: shot?.jpeg ?? null, upload: this.upload, typed: this.typed, which: this.which, course: this.d.course() };
    let hidden: SolverResult;
    try {
      // The quick read: a few seconds, so the help buttons work almost at once.
      const t0 = this.now();
      hidden = await this.ai.solve(ctx, input, 'fast');
      this.log(`quick read ${this.now() - t0} ms: ${hidden.pageKind ?? '?'}, problem ${hidden.problemDetected ? 'yes' : 'no'}, ${hidden.candidates?.length ?? 0} candidate(s)${hidden.ambiguous ? ', ambiguous' : ''}`);
    } catch (e) {
      this.log(`quick read failed: ${String(e)}`);
      if (epoch !== this.epoch) return;
      this.set({ phase: 'noProblem', busy: null });
      // A key that doesn't work needs the student even on a read they didn't ask for; anything else waits for them to press something.
      if (!quiet || (e instanceof LlmError && (e.kind === 'auth' || e.kind === 'model' || e.kind === 'quota'))) this.errorBubble(e);
      return;
    }
    if (epoch !== this.epoch) return;
    this.lastPageKind = hidden.pageKind;
    // Several problems and nothing to say which: ask (unless the student already said which one).
    if (hidden.ambiguous && hidden.candidates && hidden.candidates.length >= 2 && !this.which) {
      this.askWhich(this.safeCandidates(hidden.candidates, hidden));
      return;
    }
    if (!hidden.problemDetected || !hidden.problemText) {
      this.set({ phase: 'noProblem', mood: 'idle', busy: null });
      if (!quiet) this.noQuestion();
      // Keep an eye on the page: when the student starts writing a problem, it is read by itself.
      if (shot && !this.upload && !this.typed) {
        this.gate = markRead(this.gate, shot.thumb, this.now());
        this.startWatching();
      }
      return;
    }

    this.useKey(hidden, win);
    if (!quiet)
      this.bubble({
        kind: 'hello',
        title: 'Got it!',
        text: `Looks like ${this.ui.problem}. I'll watch your work as you go and point out a slip if I see one.`,
        actions: this.helpActions(),
        autoHideMs: 7000,
      });
    this.startWatching();
    // A first look at whatever is already written.
    if (shot) void this.read(shot, epoch, 'the problem was just read');
    // The careful read, on the stronger model, in the background: when it lands, it replaces the quick key.
    if (ctx.smartModel && ctx.smartModel !== ctx.model) void this.upgradeKey(ctx, input, epoch, win);
  }

  /** The page seemed to show another problem: read it, and start over on it only if it really is a different one. */
  private async switchIfNew(): Promise<void> {
    const ctx = this.d.llm();
    const win = this.d.workWindow();
    if (!ctx || !win || !this.hidden || this.checkingNew) return;
    this.checkingNew = true;
    this.readAt = this.now();
    const epoch = this.epoch;
    try {
      const shot = await this.d.screen.shot(win, 'read');
      if (!shot || epoch !== this.epoch) return;
      const found = await this.ai.solve(ctx, { screen: shot.jpeg, upload: null, typed: '', which: '', course: this.d.course() }, 'fast');
      if (epoch !== this.epoch) return;
      if (!found.problemDetected || !found.problemText || sameProblem(found, this.hidden)) {
        this.log('the page still shows the same problem; keeping it');
        this.differentStreak = 0;
        return;
      }
      this.log('the student moved on to a new problem');
      void this.call(undefined, true);
    } catch (e) {
      this.log(`checking for a new problem failed: ${String(e)}`);
    } finally {
      this.checkingNew = false;
    }
  }

  /** Makes this the answer key: the problem's name on the status line, and the video for it found in the background. */
  private useKey(hidden: SolverResult, win: WinInfo | null): void {
    this.hidden = hidden;
    this.uploadSentToReview = false;
    if (hidden.videoConcept && this.d.hasSerpKey()) this.d.videos.prefetch(hidden.videoConcept, hidden.videoQuery || `${hidden.videoConcept} explained`);
    // On a "which rule applies?" question the method's name IS the answer, so it is only shown when it gives nothing away.
    const label = hidden.problemKind || hidden.conceptTags[0] || '';
    const name = label && !labelLeaks(label, hidden) ? label : 'this problem';
    this.set({ code: hidden.domain === 'programming' || hidden.workFormat === 'code', phase: 'watching', mood: this.ui.mood === 'think' ? 'happy' : this.ui.mood, busy: null, problem: name, watching: win ? appName(win.title) : this.ui.watching });
  }

  private async upgradeKey(ctx: LlmCtx, input: SolveInput, epoch: number, win: WinInfo | null): Promise<void> {
    try {
      const t0 = this.now();
      const better = await this.ai.solve(ctx, input, 'smart');
      this.log(`careful read ${this.now() - t0} ms`);
      if (epoch !== this.epoch || !better.problemDetected || !better.problemText) return;
      // The problem the student sees stays the problem: a careful read that landed on a different one is not used.
      if (this.hidden && !sameProblem(this.hidden, better)) {
        this.log('the careful read found a different problem; the quick one stays');
        return;
      }
      this.log('the careful read replaced the quick one');
      this.useKey(better, win);
    } catch (e) {
      // The quick key stays.
      this.log(`careful read failed: ${String(e)}`);
    }
  }

  /**
   * For Hint, Video and Check: makes sure the problem has been read. Waits for a read that is running; starts one when there is none.
   * False when there is still no problem afterwards (then the student has been told what to do).
   */
  private async ensureProblem(action: 'hint' | 'video' | 'check'): Promise<boolean> {
    if (this.hidden) return true;
    const what = { hint: 'give you a hint', video: 'find you a video', check: 'check your work' }[action];
    if (this.ui.phase !== 'choosing') {
      const reading = this.readPromise;
      this.bubble({ kind: 'info', title: 'Reading the problem first…', text: `Then I'll ${what}.`, pending: true });
      if (reading) await reading;
      else await this.call(undefined, true);
    }
    if (this.hidden) return true;
    // Several problems: ask which one, and do what they asked as soon as they pick.
    if (this.ui.phase === 'choosing') {
      this.pendingAction = action;
      this.askWhich(this.candidates, what);
      return false;
    }
    if (this.ui.bubble?.kind !== 'error') this.noQuestion();
    return false;
  }

  /** "I don't see a question on this page": said when the student asks for help and there is no problem to help with. */
  private noQuestion(): void {
    this.bubble({
      kind: 'error',
      title: "I don't see a question on this page",
      text:
        this.lastPageKind === 'notes'
          ? "This looks like notes, not a problem to work on. When you start one (like \"Example 1: …\" or a homework question), I'll pick it up."
          : "Write or open the problem you are working on and I'll pick it up. You can also upload a photo or PDF of it.",
      actions: [{ id: 'retry', label: 'Read again' }, ...this.giveProblemActions()],
    });
    this.set({ mood: 'worry' });
  }

  /** What the page calls each problem and what it asks, minus anything that would give an answer away. */
  private safeCandidates(candidates: ProblemCandidate[], hidden: SolverResult): ProblemCandidate[] {
    return candidates.map((c, i) => ({
      ...c,
      label: c.label && !labelLeaks(c.label, hidden) ? c.label : `Problem ${i + 1}`,
      summary: c.summary && !labelLeaks(c.summary, hidden) ? c.summary : '',
    }));
  }

  /** Several problems on the page and nothing shows which one: a button for each. */
  private askWhich(candidates: ProblemCandidate[], then?: string): void {
    this.candidates = candidates;
    this.set({ phase: 'choosing', mood: 'think', busy: null });
    const list = candidates
      .slice(0, 4)
      .filter((c) => c.summary)
      .map((c) => `${c.label}: ${c.summary}`)
      .join('\n');
    const ask = then ? `Tap the one you're working on, and I'll ${then}.` : "I see more than one. Tap the one you're working on.";
    this.bubble({
      kind: 'info',
      title: 'Which question are we on?',
      text: list ? `${ask}\n${list}` : ask,
      actions: [...candidates.slice(0, 4).map((c) => ({ id: 'pickProblem' as const, label: c.label, arg: c.label })), { id: 'retry', label: 'Read again' }],
    });
  }

  /** The student picked which problem: read that one, then do what they had asked for. */
  private async pickProblem(label: string): Promise<void> {
    if (!label) return;
    const then = this.pendingAction;
    this.pendingAction = null;
    this.which = label;
    await this.call('screen');
    if (!this.hidden || !then) return;
    if (then === 'hint') return this.hint();
    if (then === 'video') return this.video();
    return this.check();
  }

  private reset(): number {
    this.epoch++;
    this.stopWatching();
    this.hidden = null;
    this.history = [];
    this.hintsGiven = 0;
    this.work = { status: 'unknown', observation: '', reviewedAt: 0 };
    this.gate = initialGate();
    this.reading = false;
    this.markBox = null;
    this.dismissedBoxes = [];
    this.copyStreak = 0;
    this.noWorkStreak = 0;
    this.differentStreak = 0;
    this.solved = false;
    this.set({ mark: null });
    return this.epoch;
  }

  /** A nap: tanrushu stays on screen but stops reading anything until it's tapped. */
  sleep(): void {
    this.reset();
    this.upload = null;
    this.typed = '';
    this.which = '';
    this.readFrom = null;
    this.set({ phase: 'asleep', mood: 'idle', busy: null, problem: '', source: null, watching: '' });
    this.bubble({ kind: 'info', title: 'Taking a nap', text: 'Tap me when you want me back.', autoHideMs: 2500 });
  }

  // ---------------- watching the work ----------------

  private startWatching(): void {
    this.stopWatching();
    this.timer = setInterval(() => void this.tick(), this.d.tickMs ?? WATCH_TICK_MS);
  }

  private stopWatching(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One watch tick. Public so tests can step it. */
  async tick(): Promise<void> {
    if (this.ui.phase === 'noProblem' && !this.hidden) return this.tickNoProblem();
    if (!this.hidden || this.ui.phase !== 'watching') return;
    const epoch = this.epoch;
    const win = this.d.workWindow();
    if (!win) return;
    // Switched to an app tanrushu doesn't show in (music, email…): nothing there is homework, so nothing is read.
    if (this.d.canWatch && !this.d.canWatch(win)) return this.syncMark(null);
    this.syncMark(win);
    let thumbShot: Shot | null;
    try {
      thumbShot = await this.d.screen.shot(win, 'tick');
    } catch {
      return;
    }
    if (!thumbShot || epoch !== this.epoch) return;
    const appNow = appName(win.title);
    if (appNow !== this.ui.watching) this.set({ watching: appNow });
    // The student is changing the marked spot (or the page scrolled): the square steps aside until the next read says how it went.
    const m = this.markBox;
    if (m && !m.edited && (regionChanged(m.shot.thumb, thumbShot.thumb, m.box) || thumbDiff(m.shot.thumb, thumbShot.thumb) > PAGE_CHANGE)) {
      m.edited = true;
      this.syncMark(win);
    }
    const decision = gateTick(this.gate, thumbShot.thumb, this.now(), this.d.idleSec(), this.reading);
    this.gate = decision.state;
    if (!decision.read) return;
    let shot: Shot | null;
    try {
      shot = await this.d.screen.shot(win, 'read');
    } catch {
      return;
    }
    if (shot && epoch === this.epoch) await this.read(shot, epoch, decision.why);
  }

  /** No problem on the page yet: when the page changes and settles (the student wrote something), read it again, quietly. */
  private async tickNoProblem(): Promise<void> {
    const win = this.d.workWindow();
    if (!win || this.readPromise || (this.d.canWatch && !this.d.canWatch(win))) return;
    if (this.now() - this.readAt < NO_PROBLEM_REREAD_MS) return;
    const epoch = this.epoch;
    let thumbShot: Shot | null;
    try {
      thumbShot = await this.d.screen.shot(win, 'tick');
    } catch {
      return;
    }
    if (!thumbShot || epoch !== this.epoch || this.ui.phase !== 'noProblem') return;
    const decision = gateTick(this.gate, thumbShot.thumb, this.now(), this.d.idleSec(), false);
    this.gate = decision.state;
    if (decision.read) void this.call(undefined, true);
  }

  /**
   * The red square is shown only over the window it belongs to, in front, where it was (same window, same tab or page title, not moved),
   * and not while the student is changing that spot. Anywhere else it is taken down, and it comes back when they return to that window.
   */
  private syncMark(front: WinInfo | null): void {
    const m = this.markBox;
    let show = false;
    if (m && !m.edited && front && this.ui.phase === 'watching') {
      const was = m.shot;
      const nowDip = this.d.screen.toDip(front.rect);
      show =
        front.hwnd === was.win.hwnd &&
        front.title === was.win.title &&
        !front.minimized &&
        Math.abs(nowDip.x - was.rectDip.x) <= 4 &&
        Math.abs(nowDip.y - was.rectDip.y) <= 4 &&
        Math.abs(nowDip.width - was.rectDip.width) <= 8 &&
        Math.abs(nowDip.height - was.rectDip.height) <= 8;
    }
    if (show && m && !this.ui.mark) this.set({ mark: markFor(m.box, m.shot, this.d.overlayOrigin(), m.id, m.label) });
    else if (!show && this.ui.mark) this.set({ mark: null });
  }

  /** The window in front changed (from the app): the red square follows it. */
  frontChanged(front: WinInfo | null): void {
    this.syncMark(front && (!this.d.canWatch || this.d.canWatch(front)) ? front : null);
  }

  /** Reads the work on one shot and reacts. `final` is a check the student asked for. */
  private async read(shot: Shot, epoch: number, why: string, final = false): Promise<WorkReview | null> {
    const ctx = this.d.llm();
    if (!ctx || !this.hidden) return null;
    this.reading = true;
    this.gate = markRead(this.gate, shot.thumb, this.now());
    let r: WorkReview;
    try {
      r = await this.ai.review(ctx, {
        hidden: this.hidden,
        workImage: shot.jpeg,
        problemFile: this.upload && !this.uploadSentToReview ? { data: this.upload.data, mimeType: this.upload.mimeType } : null,
        previous: this.work.observation,
        final,
        why,
        idleSec: this.d.idleSec(),
        course: this.d.course(),
      });
      this.uploadSentToReview = true;
    } catch (e) {
      this.reading = false;
      if (final && epoch === this.epoch) this.errorBubble(e);
      this.log(`review failed: ${String(e)}`);
      return null;
    }
    this.reading = false;
    if (epoch !== this.epoch || !this.hidden) return null;
    const hadMark = !!this.markBox;
    this.work = {
      status: r.differentProblem ? 'different_problem' : r.status === 'mistake' ? 'possible_mistake' : r.status === 'solved' ? 'solved' : r.status === 'on_track' ? 'on_track' : r.status === 'no_work' ? 'no_work' : 'unknown',
      observation: r.observation,
      reviewedAt: this.now(),
      read: r.workRead,
      readability: r.readability,
      copiedWrong: r.copiedWrong,
      copyState: r.copyState,
    };
    this.log(`read (${why}): ${r.status}${r.copiedWrong ? ' (copied wrong)' : ''}${r.box ? ` box ${r.box.join(',')}` : ''}`);

    if (r.differentProblem) {
      this.differentStreak++;
      if (final) this.bubble({ kind: 'check', title: 'Different problem?', text: "I don't see work on this problem right now. Show me the work, or read the new problem.", actions: [{ id: 'newProblem', label: 'Read the new problem' }] });
      // Two reads in a row say the student moved on (one can be a scroll or a glance away): look at the page again, and switch only if
      // the problem there really is a new one. Not more often than every 20 s, and never over one they uploaded or typed.
      else if (this.differentStreak >= 2 && !this.upload && !this.typed && this.now() - this.readAt >= REREAD_GAP_MS) void this.switchIfNew();
      return r;
    }
    this.differentStreak = 0;

    // The final answer is written, in one of its accepted forms, and the reviewer saw nothing wrong: it is solved, even when a quick
    // review was too cautious to say so.
    if ((r.status === 'on_track' || r.status === 'unclear') && !r.differentProblem && this.hidden && writesAnswer(r.workRead, this.hidden)) {
      this.log('the final answer is on the page: solved');
      r = { ...r, status: 'solved', studentMessage: '' };
    }
    if (r.status === 'solved') {
      await this.celebrate(r, epoch);
      return r;
    }

    if (r.status === 'mistake') {
      if (r.copiedWrong) {
        this.copyStreak++;
        // A wrong copy is only called out once two reads in a row agree (a half-written copy always looks wrong).
        if (this.copyStreak < COPY_READS_TO_FLAG && !final) return r;
      } else this.copyStreak = 0;
      await this.flag(r, shot, epoch, final);
      return r;
    }

    this.copyStreak = 0;
    // "No work" right after a marked mistake is usually a misread, not a fix: the square only goes after two such reads in a row, and
    // without praise. Only work that reads as right earns "Nice fix!".
    this.noWorkStreak = r.status === 'no_work' ? this.noWorkStreak + 1 : 0;
    if (hadMark && r.status === 'on_track') {
      this.markBox = null;
      this.set({ mark: null, mood: 'happy' });
      this.bubble({ kind: 'fixed', title: 'Nice fix!', text: 'That part looks right now. Keep going!', autoHideMs: 5000 });
    } else if (hadMark && r.status === 'no_work') {
      if (this.noWorkStreak >= 2) {
        this.markBox = null;
        this.set({ mark: null });
      }
    } else if (final) {
      const kind = r.status === 'on_track' ? 'incomplete' : 'unclear';
      const text = await this.safe(r.studentMessage, pick(FALLBACK_CHECK[kind], this.ids), epoch);
      if (text === null) return r;
      this.bubble({
        kind: 'check',
        title: r.status === 'on_track' ? 'So far, so good' : "I couldn't check it",
        text,
        actions: r.status === 'on_track' ? [{ id: 'hint', label: 'Hint' }] : [],
      });
      this.set({ mood: r.status === 'on_track' ? 'happy' : 'worry' });
    }
    return r;
  }

  /** True if a short piece of text shown to the student (a label, a video title) would give the answer away. */
  private leaks(text: string): boolean {
    return !!this.hidden && labelLeaks(text, this.hidden);
  }

  /** A student message passes the leak guard, or the fallback is used. Null when the problem changed meanwhile. */
  private async safe(message: string, fallback: string, epoch: number): Promise<string | null> {
    const ctx = this.d.llm();
    if (!message || !ctx || !this.hidden) return fallback;
    try {
      const { verdict } = await this.ai.check(ctx, this.hidden, message);
      if (epoch !== this.epoch) return null;
      return verdict.leaks ? fallback : message;
    } catch {
      return epoch === this.epoch ? fallback : null;
    }
  }

  private async flag(r: WorkReview, shot: Shot, epoch: number, final: boolean): Promise<void> {
    // The same slip the student already closed is not shown again until something else is wrong.
    if (r.box && !final && this.dismissedBoxes.some((b) => overlap(b, r.box!) > 0.5)) return;
    // The slip that is already marked, read again: the square stays (moved to where it is now), and the bubble the student is looking at
    // (a hint, a video they asked for) is left alone.
    if (r.box && !final && this.markBox && (overlap(this.markBox.coarse, r.box) > 0.3 || overlap(this.markBox.box, r.box) > 0.3)) {
      // Still wrong after an edit: the square comes back where it was. Nothing new to say, so the bubble is left alone.
      Object.assign(this.markBox, { shot, coarse: r.box, edited: false });
      this.syncMark(this.d.workWindow());
      return;
    }
    const label = r.copiedWrong ? 'Compare with the problem' : 'Check this part';
    const id = ++this.ids;
    // The square hugs the wrong piece: a close look at where the reviewer pointed finds it exactly. Meanwhile the message goes through
    // the leak guard, so both are ready at about the same time.
    const placing = r.box ? this.preciseBox(r, shot) : Promise.resolve(null);
    const bubbleId = this.bubble({
      kind: r.copiedWrong ? 'copy' : 'mistake',
      title: r.copiedWrong ? "That doesn't match the problem" : 'Hmm, take another look',
      text: '',
      pending: true,
    });
    this.set({ mood: 'alert' });
    const [box, text] = await Promise.all([placing, this.safe(r.studentMessage, pick(r.copiedWrong ? FALLBACK_CHECK.copy : FALLBACK_CHECK.mistake, id), epoch)]);
    if (epoch !== this.epoch) return;
    if (r.box && box) {
      this.markBox = { box, coarse: r.box, shot, id, label, edited: false };
      this.set({ mark: null });
      this.syncMark(this.d.workWindow());
    }
    if (text === null) return;
    // The piece of their own work that is wrong, quoted as they wrote it, so they can find it at once.
    // It is their own writing, so it gives nothing away; only something that isn't in what they wrote goes through the answer check.
    const own = !!r.wrongPart && normalize(r.workRead).includes(normalize(r.wrongPart));
    const quote = r.wrongPart && (own || !this.leaks(r.wrongPart)) ? r.wrongPart : undefined;
    this.updateBubble(bubbleId, { text, quote, pending: false, actions: [{ id: 'hint', label: 'Hint' }, { id: 'video', label: 'Video' }, ...(r.box ? [{ id: 'hideMark' as const, label: 'Hide the square' }] : [])] });
  }

  /** The reviewer's box, made exact with a close look at that part of the work. Falls back to the reviewer's box if the close look fails. */
  private async preciseBox(r: WorkReview, shot: Shot): Promise<Box> {
    const coarse = r.box!;
    const ctx = this.d.llm();
    if (!ctx || !r.wrongPart || !this.d.screen.zoom) return coarse;
    try {
      const close = await this.d.screen.zoom(shot, coarse);
      if (!close) return coarse;
      const inner = await this.ai.locate(ctx, close.jpeg, r.wrongPart);
      if (!inner) return coarse;
      const exact = fromCloseUp(inner, close.region);
      this.log(`square placed: ${coarse.join(',')} → ${exact.join(',')}`);
      return exact;
    } catch (e) {
      this.log(`close look failed: ${String(e)}`);
      return coarse;
    }
  }

  private async celebrate(r: WorkReview, epoch: number): Promise<void> {
    if (this.solved) return;
    this.solved = true;
    this.markBox = null;
    const count = this.d.addSolved();
    this.set({ mark: null, mood: 'cheer', cheer: this.ui.cheer + 1, solvedToday: count });
    const id = this.bubble({ kind: 'cheer', title: 'You got it!', text: '', pending: true });
    // The answer is on their page now: the congratulations may name it, so it skips the answer check (a cheer that says what they got
    // right is better than a generic one).
    const text = r.studentMessage || pick(FALLBACK_CHECK.correct, count);
    if (epoch !== this.epoch) return;
    this.updateBubble(id, {
      text: `${text} That's ${count} solved today.`,
      pending: false,
      actions: [{ id: 'newProblem', label: 'Next problem' }, { id: 'sleep', label: "I'm done" }],
    });
    setTimeout(() => {
      if (this.epoch === epoch && this.ui.mood === 'cheer') this.set({ mood: 'happy' });
    }, CHEER_MS);
  }

  // ---------------- what the student asks for ----------------

  async hint(): Promise<void> {
    if (this.ui.busy === 'hint') return this.stillWorking('Thinking of a hint…');
    if (!(await this.ensureProblem('hint'))) return;
    const ctx = this.d.llm();
    if (!ctx || !this.hidden) return;
    const epoch = this.epoch;
    const id = this.startBusy('hint', 'Thinking of a hint…');
    const win = this.d.workWindow();
    let image: string | undefined;
    try {
      const shot = win ? await this.d.screen.shot(win, 'read') : null;
      image = shot?.jpeg || undefined;
    } catch {
      /* hint without a fresh picture */
    }
    let g: GuardedTurn;
    try {
      g = await this.ai.hint(ctx, {
        hidden: this.hidden,
        history: [...this.history],
        action: this.hintsGiven ? 'another' : 'hint',
        minLevel: Math.min(3, 1 + this.hintsGiven) as HintLevel,
        work: { status: this.work.status, observation: this.work.observation, reviewedAt: this.work.reviewedAt, image },
        course: this.d.course(),
      });
    } catch (e) {
      this.endBusy('hint');
      if (epoch === this.epoch) this.errorBubble(e);
      return;
    }
    this.endBusy('hint');
    if (epoch !== this.epoch) return;
    this.hintsGiven++;
    this.history.push({ role: 'tutor', text: g.turn.message, t: this.now() });
    // The missing idea's name becomes a button label, so it gets the same answer check as the hint itself.
    const prereq = g.turn.missingPrerequisite && !this.leaks(g.turn.missingPrerequisite) ? g.turn.missingPrerequisite : '';
    if (prereq && this.d.hasSerpKey()) this.d.videos.prefetch(prereq, `${prereq} explained`);
    const actions: Bubble['actions'] = [{ id: 'another', label: 'Another hint' }];
    actions.push(prereq ? { id: 'videoFor', label: `Video: ${prereq}`, arg: prereq } : { id: 'video', label: 'Video' });
    this.set({ mood: 'happy' });
    if (this.ui.bubble?.id === id) this.updateBubble(id, { title: `Hint ${this.hintsGiven}`, text: g.turn.message, pending: false, actions });
    else this.bubble({ kind: 'hint', title: `Hint ${this.hintsGiven}`, text: g.turn.message, actions });
  }

  async video(concept?: string): Promise<void> {
    if (this.ui.busy === 'video') return this.stillWorking('Finding a video…');
    if (!(await this.ensureProblem('video')) || !this.hidden) return;
    if (!this.d.hasSerpKey()) {
      this.bubble({ kind: 'error', title: 'I need a SerpApi key for videos', text: 'Add your SerpApi key in setup and I can find you a short video.', actions: [{ id: 'setup', label: 'Open setup' }] });
      return;
    }
    const named = concept || this.hidden.videoConcept || this.hidden.conceptTags[0] || this.hidden.problemKind || '';
    const c = named && !this.leaks(named) ? named : 'this topic';
    const query = concept ? `${concept} explained` : this.hidden.videoQuery || `${c} explained`;
    const epoch = this.epoch;
    const id = this.startBusy('video', `Finding a video on ${c}…`);
    let m: VideoMoment | null;
    try {
      // Usually already found in the background; a moment more lets the exact minute land if it is nearly there.
      m = await this.d.videos.get(c, query, 1500);
    } catch (e) {
      this.endBusy('video');
      if (epoch === this.epoch) this.errorBubble(e);
      return;
    }
    this.endBusy('video');
    if (epoch !== this.epoch) return;
    this.set({ mood: 'happy' });
    if (!m) {
      this.updateBubble(id, { title: 'No video found', text: `I couldn't find a good short video on ${c}. Want a hint instead?`, pending: false, actions: [{ id: 'hint', label: 'Hint' }] });
      return;
    }
    // A video's title comes from YouTube and could happen to state this problem's answer: such a video is never shown.
    if (this.leaks(m.title)) {
      this.updateBubble(id, { title: 'No video found', text: `I couldn't find a short video on ${c} that doesn't give the answer away. Want a hint instead?`, pending: false, actions: [{ id: 'hint', label: 'Hint' }] });
      return;
    }
    const card = (v: VideoMoment, refining: boolean) => ({ videoId: v.videoId, title: v.title, channel: v.channel, at: clock(v.start), why: this.leaks(v.why) ? `How ${c} works` : v.why, url: clipUrl(v), refining });
    const refining = m.source === 'metadata';
    this.updateBubble(id, {
      title: `A short video on ${c}`,
      text: refining ? 'Starting from the top while I find the exact minute…' : `Start at ${clock(m.start)}: that's where it explains it.`,
      pending: false,
      video: card(m, refining),
      actions: [{ id: 'watch', label: `Watch it (${clock(m.start)})` }],
    });
    if (refining) {
      const better = await this.d.videos.whenRefined(c);
      if (better && epoch === this.epoch && better.videoId === m.videoId && better.source === 'video')
        this.updateBubble(id, { text: `Start at ${clock(better.start)}: that's where it explains it.`, video: card(better, false), actions: [{ id: 'watch', label: `Watch it (${clock(better.start)})` }] });
      else this.updateBubble(id, { text: 'Watch from the start.', video: card(m, false) });
    }
  }

  async check(): Promise<void> {
    if (this.ui.busy === 'check') return this.stillWorking('Checking your work…');
    if (!(await this.ensureProblem('check'))) return;
    const win = this.d.workWindow();
    if (!win) {
      this.bubble({ kind: 'error', title: "I can't see your work", text: 'Click on the window you are writing in, then press Check my work again.' });
      return;
    }
    const epoch = this.epoch;
    this.startBusy('check', 'Checking your work…');
    let shot: Shot | null = null;
    try {
      shot = await this.d.screen.shot(win, 'read');
    } catch (e) {
      this.log(String(e));
    }
    if (!shot) {
      this.endBusy('check');
      this.bubble({ kind: 'error', title: "I can't see your work", text: 'I could not take a picture of that window. Try clicking on it first.' });
      return;
    }
    // Wait for a read already in flight so two answers don't race.
    for (let i = 0; i < 100 && this.reading; i++) await new Promise((r) => setTimeout(r, 100));
    try {
      await this.read(shot, epoch, 'the student asked to check their work', true);
    } finally {
      this.endBusy('check');
    }
  }
}
