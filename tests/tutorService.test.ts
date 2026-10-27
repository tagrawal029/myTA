// The whole tutor, driven with a fake screen and fake model calls: call → read the problem → watch → red square on a slip → hint →
// video → solved, plus the paths where something is missing.
import { describe, expect, it, vi } from 'vitest';
import { LlmError, type LlmCtx } from '../src/core/ai/llmClient';
import type { WorkReview } from '../src/core/ai/work';
import { VideoCache } from '../src/core/serp/cache';
import { VideoFinder } from '../src/core/serp/videoFinder';
import type { Box, SolverResult, TutorTurn } from '../src/core/shared/types';
import type { UiState } from '../src/core/shared/ui';
import type { ScreenSource, Shot } from '../src/main/capture';
import { closeUpRegion } from '../src/main/captureMath';
import { TutorService, type AiFns } from '../src/main/tutorService';
import type { WinInfo } from '../src/main/win32';

const KEY: SolverResult = {
  problemText: 'Find dy/dx for y = sin(3x^2)',
  finalAnswer: '6x cos(3x^2)',
  keySteps: ['outer function sin', 'derivative of the inside 3x^2 is 6x'],
  conceptTags: ['chain rule'],
  misconceptions: ['forgetting the inner derivative'],
  answerKeyPhrases: ['6x cos(3x^2)'],
  problemDetected: true,
  problemKind: 'chain rule',
  domain: 'calculus',
  difficulty: 2,
  videoConcept: 'chain rule',
  videoQuery: 'chain rule explained',
};

const review = (o: Partial<WorkReview>): WorkReview => ({
  status: 'on_track',
  differentProblem: false,
  wrongPart: '',
  copiedWrong: false,
  copyState: 'complete',
  observation: '',
  studentMessage: '',
  box: null,
  workRead: '',
  readability: 'clear',
  ...o,
});

const WIN: WinInfo = { hwnd: 9, pid: 99, title: 'Calc homework - OneNote', cls: 'x', rect: { x: 0, y: 0, width: 1000, height: 800 }, minimized: false, exe: 'onenote.exe' };

function rig(opts: { key?: boolean; serp?: boolean; win?: WinInfo | null; reviews?: WorkReview[]; solve?: AiFns['solve']; hintLeak?: boolean; course?: boolean; videoTitle?: string; prereq?: string; locate?: Box | null; hint?: AiFns['hint']; busyLimitMs?: number } = {}) {
  const states: UiState[] = [];
  let picture = 1;
  const screen: ScreenSource = {
    toDip: (r) => r,
    zoom: async (_shot, box) => ({ jpeg: 'CLOSE', region: closeUpRegion(box) }),
    shot: async (win, mode): Promise<Shot> => ({ jpeg: mode === 'read' ? `JPEG${picture}` : '', width: 1000, height: 800, win, rectDip: { x: 0, y: 0, width: 1000, height: 800 }, thumb: new Uint8Array(160 * 120).fill(picture), at: Date.now() }),
  };
  const reviews = [...(opts.reviews ?? [])];
  const calls: { kind: string; arg: unknown }[] = [];
  const ai: AiFns = {
    solve: opts.solve ?? (async (_c, input) => (calls.push({ kind: 'solve', arg: input }), KEY)),
    review: async (_c, a) => (calls.push({ kind: 'review', arg: a }), reviews.shift() ?? review({})),
    hint: opts.hint ?? (async (_c, a) => {
      calls.push({ kind: 'hint', arg: a });
      const turn: TutorTurn = { replyAssessment: 'none', hintLevel: a.minLevel, message: `hint at level ${a.minLevel}`, missingPrerequisite: a.minLevel >= 2 ? (opts.prereq ?? 'composite functions') : '' };
      return { turn, fallback: false, attempts: [] };
    }),
    locate: async (_c, closeUp, wrongPart) => (calls.push({ kind: 'locate', arg: { closeUp, wrongPart } }), opts.locate ?? null),
    check: async (_c, _h, m) => ({ verdict: { leaks: !!opts.hintLeak && /6x/.test(m), reason: opts.hintLeak ? 'gives the inner derivative' : '' } }),
  };
  const opened: string[] = [];
  const videos = new VideoFinder(new VideoCache({ get: async () => ({}), set: async () => undefined }, {}), () => ({ serpKey: 's', ctx: null }), {
    search: async (_k, q) => (calls.push({ kind: 'search', arg: q }), [{ videoId: 'abcdefghijk', title: opts.videoTitle ?? 'The chain rule', channel: 'Khan Academy', lengthSec: 500, description: '', chapters: [{ title: 'The chain rule', startSec: 75 }] }]),
    watch: async () => null,
  });
  let solved = 0;
  let clockMs = 1_000_000;
  const ctx: LlmCtx = { apiKey: 'g', model: 'm' };
  const t = new TutorService({
    llm: () => (opts.key === false ? null : ctx),
    hasSerpKey: () => opts.serp !== false,
    course: () => (opts.course ? { course: 'Calc I', coveredUpTo: 'week 5', topics: ['chain rule'], updatedAt: 0 } : null),
    workWindow: () => (opts.win === undefined ? WIN : opts.win),
    screen,
    idleSec: () => 3,
    overlayOrigin: () => ({ x: 0, y: 0 }),
    emit: (s) => states.push(s),
    openUrl: (u) => opened.push(u),
    openSetup: () => opened.push('setup'),
    openProblem: () => opened.push('problem'),
    solvedToday: () => solved,
    addSolved: () => ++solved,
    videos,
    ai,
    tickMs: 1_000_000, // the test steps the ticks itself
    busyLimitMs: opts.busyLimitMs,
    now: () => clockMs,
  });
  const settle = () => new Promise((r) => setTimeout(r, 5));
  return { t, states, calls, opened, setPicture: (n: number) => (picture = n), settle, last: () => states[states.length - 1], wait: (ms: number) => (clockMs += ms) };
}

describe('calling the sprite', () => {
  it('reads the problem off the screen, says what it is, starts watching and finds a video in the background', async () => {
    const r = rig();
    await r.t.act({ type: 'readScreen' });
    await r.settle();
    const s = r.last();
    expect(s.phase).toBe('watching');
    expect(s.problem).toBe('chain rule');
    expect(s.watching).toBe('OneNote');
    expect(r.calls.find((c) => c.kind === 'solve')?.arg).toMatchObject({ screen: 'JPEG1', upload: null });
    expect(r.calls.some((c) => c.kind === 'search' && c.arg === 'chain rule explained')).toBe(true);
    // A first look at whatever is already written.
    expect(r.calls.filter((c) => c.kind === 'review')).toHaveLength(1);
    expect(r.t.state().bubble?.title).toBe('Got it!');
    // Nothing private reaches the overlay.
    expect(JSON.stringify(r.states)).not.toContain('6x cos');
    r.t.sleep();
  });

  it('asks for a Gemini key first when there is none', async () => {
    const r = rig({ key: false });
    await r.t.act({ type: 'readScreen' });
    expect(r.last().bubble?.title).toMatch(/Gemini key/);
    expect(r.last().bubble?.actions[0].id).toBe('setup');
  });

  it('a tap says hello and offers its options; it never starts reading twice at once', async () => {
    const r = rig();
    // On screen and awake from the start: a tap offers Hint, Video and Check right away.
    expect(r.t.state().phase).toBe('idle');
    await r.t.act({ type: 'call' });
    expect(r.last().bubble?.actions.map((a) => a.id)).toEqual(['hint', 'video']);
    expect(r.calls.filter((c) => c.kind === 'solve')).toHaveLength(0);
    const first = r.t.act({ type: 'readScreen' });
    await r.t.act({ type: 'readScreen' });
    await first;
    await r.settle();
    expect(r.calls.filter((c) => c.kind === 'solve')).toHaveLength(1);
    await r.t.act({ type: 'call' });
    expect(r.last().bubble?.title).toBe("I'm here!");
    // A nap, and a tap wakes it (and it reads the problem again).
    r.t.sleep();
    expect(r.last().phase).toBe('asleep');
    await r.t.act({ type: 'call' });
    await r.settle();
    expect(r.calls.filter((c) => c.kind === 'solve')).toHaveLength(2);
    expect(r.last().phase).toBe('watching');
    r.t.sleep();
  });

  it("says so when it can't see a window or find a problem", async () => {
    const none = rig({ win: null });
    await none.t.act({ type: 'readScreen' });
    expect(none.last()).toMatchObject({ phase: 'noProblem' });
    expect(none.last().bubble?.actions.map((a) => a.id)).toEqual(['retry', 'problem']);

    const blank = rig({ solve: async () => ({ ...KEY, problemDetected: false, problemText: '' }) });
    await blank.t.act({ type: 'readScreen' });
    expect(blank.last().bubble?.title).toBe("I don't see a question on this page");
  });

  it('turns a bad key into a setup prompt', async () => {
    const r = rig({
      solve: async () => {
        throw new LlmError('auth', 'Gemini rejected the API key.');
      },
    });
    await r.t.act({ type: 'readScreen' });
    expect(r.last().bubble).toMatchObject({ kind: 'error', title: 'I need a working Gemini key' });
  });

  it('uses an uploaded problem (and which one) instead of the screen, and gives the course topics', async () => {
    const r = rig({ course: true });
    await r.t.setProblem({ data: 'PDFDATA', mimeType: 'application/pdf', name: 'hw.pdf' }, '3b', 'upload');
    await r.settle();
    const solveArg = r.calls.find((c) => c.kind === 'solve')?.arg as { upload: { name: string }; which: string; course: { topics: string[] } };
    expect(solveArg.upload.name).toBe('hw.pdf');
    expect(solveArg.which).toBe('3b');
    expect(solveArg.course.topics).toEqual(['chain rule']);
    expect(r.last().source).toBe('upload');
    // The uploaded problem goes with the first read only.
    const first = r.calls.find((c) => c.kind === 'review')?.arg as { problemFile: unknown };
    expect(first.problemFile).toEqual({ data: 'PDFDATA', mimeType: 'application/pdf' });
    r.t.sleep();
  });
});

describe('is there a question, and which one', () => {
  it('reads a notes window by itself, quietly, once', async () => {
    const r = rig();
    r.t.autoRead(WIN);
    await r.settle();
    expect(r.last().phase).toBe('watching');
    // Quiet: no speech bubble for a read nobody asked for.
    expect(r.states.some((s) => s.bubble?.title === 'Let me take a look…' || s.bubble?.title === 'Got it!')).toBe(false);
    r.t.autoRead(WIN);
    await r.settle();
    expect(r.calls.filter((c) => c.kind === 'solve')).toHaveLength(1);
    r.t.sleep();
  });

  it('drops a picture taken after the notes window lost the front, and reads it again when it is back', async () => {
    const r = rig();
    let front = false;
    (r.t as unknown as { d: { canWatch: () => boolean } }).d.canWatch = () => front;
    r.t.autoRead(WIN);
    await r.settle();
    expect(r.calls.filter((c) => c.kind === 'solve')).toHaveLength(0);
    expect(r.last().phase).toBe('idle');
    front = true;
    r.t.autoRead(WIN);
    await r.settle();
    expect(r.calls.filter((c) => c.kind === 'solve')).toHaveLength(1);
    expect(r.last().phase).toBe('watching');
    r.t.sleep();
  });

  it('notes are not a question: it says so when help is asked for', async () => {
    const r = rig({ solve: async () => ({ ...KEY, problemDetected: false, problemText: '', pageKind: 'notes', candidates: [] }) });
    r.t.autoRead(WIN);
    await r.settle();
    expect(r.last()).toMatchObject({ phase: 'noProblem', bubble: null });
    await r.t.act({ type: 'hint' });
    expect(r.last().bubble?.title).toBe("I don't see a question on this page");
    expect(r.last().bubble?.text).toMatch(/looks like notes/);
    expect(r.calls.filter((c) => c.kind === 'hint')).toHaveLength(0);
  });

  it('with no problem on the page, it reads the page again by itself once the student writes one', async () => {
    let n = 0;
    const r = rig({ solve: async () => (n++ === 0 ? { ...KEY, problemDetected: false, problemText: '', pageKind: 'notes', candidates: [] } : KEY) });
    r.t.autoRead(WIN);
    await r.settle();
    expect(r.last().phase).toBe('noProblem');
    const solves = () => n;
    // Nothing changes: nothing is read again.
    r.wait(10_000);
    await r.t.tick();
    expect(solves()).toBe(1);
    // The student writes a problem, then stops.
    r.setPicture(60);
    await r.t.tick();
    r.wait(1500);
    await r.t.tick();
    await r.settle();
    expect(solves()).toBe(2);
    expect(r.last().phase).toBe('watching');
    // Quietly: no speech bubble for it.
    expect(r.last().bubble).toBeNull();
    r.t.sleep();
  });

  it('asks which question when there are several, then does what was asked', async () => {
    const candidates = [
      { label: 'Question 1', summary: 'Find the limit', studentWorking: false },
      { label: 'Question 2', summary: 'Find dy/dx', studentWorking: false },
    ];
    const seen: (string | undefined)[] = [];
    const r = rig({ solve: async (_c, input) => (seen.push(input.which), input.which ? { ...KEY, candidates, ambiguous: false } : { ...KEY, candidates, ambiguous: true }) });
    await r.t.act({ type: 'video' });
    const b = r.last().bubble!;
    expect(r.last().phase).toBe('choosing');
    expect(b.title).toBe('Which question are we on?');
    expect(b.actions.map((a) => a.label)).toEqual(['Question 1', 'Question 2', 'Read again']);
    expect(b.text).toContain('Question 2: Find dy/dx');
    await r.t.act({ type: 'pickProblem', arg: 'Question 2' });
    await r.settle();
    expect(seen.at(-1)).toBe('Question 2');
    expect(r.last().phase).toBe('watching');
    // The video they asked for comes right after they pick.
    expect(r.last().bubble?.kind).toBe('video');
    r.t.sleep();
  });

  it('the quick read is replaced by the careful one when it lands', async () => {
    const tiers: (string | undefined)[] = [];
    const r = rig({ solve: async (_c, _i, tier) => (tiers.push(tier), tier === 'smart' ? { ...KEY, problemKind: 'chain rule (careful)' } : KEY) });
    (r.t as unknown as { d: { llm: () => LlmCtx } }).d.llm = () => ({ apiKey: 'g', model: 'quick', smartModel: 'careful' });
    await r.t.act({ type: 'readScreen' });
    await r.settle();
    expect(tiers).toEqual(['fast', 'smart']);
    expect(r.t.answerKey()?.problemKind).toBe('chain rule (careful)');
    expect(r.last().problem).toBe('chain rule (careful)');
    r.t.sleep();
  });

  it('keeps the problem it read: a careful read that lands on another problem is not used', async () => {
    const other = { ...KEY, problemText: 'Find dy/dx for y = cos(5x^3)', problemKind: 'other problem' };
    const r = rig({ solve: async (_c, _i, tier) => (tier === 'smart' ? other : KEY) });
    (r.t as unknown as { d: { llm: () => LlmCtx } }).d.llm = () => ({ apiKey: 'g', model: 'quick', smartModel: 'careful' });
    await r.t.act({ type: 'readScreen' });
    await r.settle();
    expect(r.t.answerKey()?.problemText).toBe(KEY.problemText);
    expect(r.last().problem).toBe('chain rule');
    r.t.sleep();
  });

  it('one glance away is not a new problem; it switches only after a second look finds a really different one', async () => {
    const different = review({ status: 'unclear', differentProblem: true });
    const reads: string[] = [];
    let next = KEY;
    const r = rig({ reviews: [review({ status: 'on_track' }), different, different, different, different], solve: async () => (reads.push(next.problemText), next) });
    await r.t.act({ type: 'readScreen' });
    await r.settle();
    let picture = 0;
    const step = async () => {
      r.wait(25_000);
      r.setPicture((picture += 40));
      await r.t.tick();
      r.wait(1500);
      await r.t.tick();
      await r.settle();
    };
    await step(); // one different: nothing happens
    expect(reads).toHaveLength(1);
    await step(); // two in a row: it looks again, and it is the same problem: kept as it was
    expect(reads).toHaveLength(2);
    expect(r.t.answerKey()?.problemText).toBe(KEY.problemText);
    next = { ...KEY, problemText: 'Problem 3. Find dy/dx for y = ln(4x^5)', problemKind: 'log rule' };
    await step();
    await step(); // two more: it looks again, and this time it is new: it switches to it
    for (let i = 0; i < 20 && r.t.answerKey()?.problemText === KEY.problemText; i++) await r.settle();
    expect(r.t.answerKey()?.problemText).toBe('Problem 3. Find dy/dx for y = ln(4x^5)');
    expect(r.last().problem).toBe('log rule');
    r.t.sleep();
  });
});

describe('watching the work', () => {
  it('puts the red square on a slip a moment after the line is finished, then says where to look', async () => {
    const r = rig({ reviews: [review({ status: 'no_work' }), review({ status: 'mistake', box: [400, 100, 480, 600], observation: 'dropped the inner derivative', studentMessage: 'Look at your second line: did you differentiate the inside too?' })] });
    await r.t.act({ type: 'readScreen' });
    await r.settle();
    const reads = () => r.calls.filter((c) => c.kind === 'review').length;
    expect(reads()).toBe(1);
    // The student writes (the picture changes), then stops.
    r.wait(3000);
    r.setPicture(50);
    await r.t.tick(); // changed: still writing
    expect(reads()).toBe(1);
    r.wait(700);
    await r.t.tick(); // still for 0.7 s: not yet
    expect(reads()).toBe(1);
    r.wait(700);
    await r.t.tick(); // still for 1.4 s and idle: read it
    await r.settle();
    expect(reads()).toBe(2);
    const s = r.last();
    expect(s.mark).toMatchObject({ x: 100 - 4, y: 320 - 4, width: 500 + 8, label: 'Check this part' });
    expect(s.bubble).toMatchObject({ kind: 'mistake', text: 'Look at your second line: did you differentiate the inside too?', pending: false });
    expect(s.mood).toBe('alert');
    r.t.sleep();
  });

  it('never shows a message that gives the answer away', async () => {
    const r = rig({ hintLeak: true, reviews: [review({ status: 'mistake', box: [100, 100, 200, 300], studentMessage: 'It should be 6x cos(3x^2).' })] });
    await r.t.act({ type: 'readScreen' });
    await r.settle();
    const s = r.last();
    expect(s.bubble?.kind).toBe('mistake');
    expect(s.bubble?.text).not.toContain('6x');
    expect(s.bubble?.text.length).toBeGreaterThan(20);
    r.t.sleep();
  });

  it('only calls out a wrong copy of the problem once two reads agree', async () => {
    const copy = review({ status: 'mistake', copiedWrong: true, copyState: 'complete', box: [50, 50, 100, 500], studentMessage: 'What you wrote down does not match the problem.' });
    const r = rig({ reviews: [copy, copy] });
    await r.t.act({ type: 'readScreen' });
    await r.settle();
    expect(r.last().mark).toBeNull();
    await r.t.act({ type: 'check' });
    await r.settle();
    expect(r.last().mark?.label).toBe('Compare with the problem');
    expect(r.last().bubble?.kind).toBe('copy');
    r.t.sleep();
  });

  it('fits the square to exactly the wrong piece with a close look, and keeps the first box if that fails', async () => {
    const slip = review({ status: 'mistake', box: [300, 100, 340, 600], wrongPart: 'cos(3x^2)', studentMessage: 'Look at your second line.' });
    const r = rig({ reviews: [slip], locate: [400, 500, 600, 700] });
    await r.t.act({ type: 'readScreen' });
    await r.settle();
    const look = r.calls.find((c) => c.kind === 'locate');
    expect(look?.arg).toEqual({ closeUp: 'CLOSE', wrongPart: 'cos(3x^2)' });
    // The close-up is [235, 0, 405, 1000] of the window (twice as wide as the line, so the whole width); the piece is in its middle.
    const exact = [235 + 0.4 * 170, 0 + 0.5 * 1000, 235 + 0.6 * 170, 0 + 0.7 * 1000].map(Math.round);
    expect(r.last().mark).toMatchObject({ x: exact[1] - 4, y: Math.round((exact[0] / 1000) * 800) - 4, width: ((exact[3] - exact[1]) / 1000) * 1000 + 8 });

    const miss = rig({ reviews: [slip], locate: null });
    await miss.t.act({ type: 'readScreen' });
    await miss.settle();
    expect(miss.last().mark).toMatchObject({ x: 100 - 4, width: 500 + 8 });
    r.t.sleep();
    miss.t.sleep();
  });

  it('reading the same slip again keeps the square and leaves the hint the student asked for on screen', async () => {
    const slip = review({ status: 'mistake', box: [400, 100, 480, 600], studentMessage: 'Check the sign on line 2.' });
    const again = review({ status: 'mistake', box: [405, 110, 485, 590], studentMessage: 'Check the sign on line 2 again.' });
    const r = rig({ reviews: [slip, again] });
    await r.t.act({ type: 'readScreen' });
    await r.settle();
    await r.t.act({ type: 'hint' });
    await r.settle();
    expect(r.last().bubble?.kind).toBe('hint');
    const markId = r.last().mark?.id;
    // The page changes a little and is read again: same slip.
    r.wait(5000);
    r.setPicture(70);
    await r.t.tick();
    r.wait(1500);
    await r.t.tick();
    await r.settle();
    expect(r.calls.filter((c) => c.kind === 'review')).toHaveLength(2);
    expect(r.last().bubble?.kind).toBe('hint');
    expect(r.last().mark?.id).toBe(markId);
    r.t.sleep();
  });

  it('cheers when the right answer is written, even when the quick review only says "on track"', async () => {
    const identity = { ...KEY, problemText: 'Solve for x: 3x - 7 = 3x - 7', finalAnswer: 'all real numbers', answerForms: ['infinitely many solutions'] };
    const r = rig({ solve: async () => identity, reviews: [review({ status: 'on_track', workRead: '3x - 7 = 3x - 7 / -7 = -7 / infinitely many solutions' })] });
    await r.t.act({ type: 'readScreen' });
    await r.settle();
    expect(r.last().bubble?.title).toBe('You got it!');
    expect(r.last().solvedToday).toBe(1);
    r.t.sleep();
  });

  it('quotes the student own wrong writing back, but never a piece of the answer they did not write', async () => {
    const own = rig({ reviews: [review({ status: 'mistake', box: [400, 100, 480, 600], workRead: 'y = sin(3x²) / dy/dx = cos(3x²)', wrongPart: 'cos(3x²)', studentMessage: 'Look at your last line.' })] });
    await own.t.act({ type: 'readScreen' });
    await own.settle();
    expect(own.last().bubble?.quote).toBe('cos(3x²)');
    own.t.sleep();
    const notTheirs = rig({ reviews: [review({ status: 'mistake', box: [400, 100, 480, 600], workRead: 'y = sin(3x²)', wrongPart: '6x cos(3x²)', studentMessage: 'Look at your last line.' })] });
    await notTheirs.t.act({ type: 'readScreen' });
    await notTheirs.settle();
    expect(notTheirs.last().bubble?.quote).toBeUndefined();
    notTheirs.t.sleep();
  });

  it('the square is only ever over its own window: another window or another tab in front takes it down, and coming back restores it', async () => {
    const slip = review({ status: 'mistake', box: [400, 100, 480, 600], studentMessage: 'Check the sign on line 2.' });
    const r = rig({ reviews: [slip] });
    await r.t.act({ type: 'readScreen' });
    await r.settle();
    expect(r.last().mark).not.toBeNull();
    r.t.frontChanged({ ...WIN, hwnd: 77, title: 'Other notes - OneNote' });
    expect(r.last().mark).toBeNull();
    r.t.frontChanged(WIN);
    expect(r.last().mark).not.toBeNull();
    // Same browser window, another tab: a different title.
    r.t.frontChanged({ ...WIN, title: 'YouTube - Google Chrome' });
    expect(r.last().mark).toBeNull();
    r.t.frontChanged(null);
    expect(r.last().mark).toBeNull();
    r.t.frontChanged(WIN);
    expect(r.last().mark).not.toBeNull();
    // Moved window: the square would be in the wrong place, so it stays down.
    r.t.frontChanged({ ...WIN, rect: { ...WIN.rect, x: 200 } });
    expect(r.last().mark).toBeNull();
    r.t.sleep();
  });

  it('the square steps aside while the student fixes that spot, then goes for good with a Nice fix, or comes back if it is still wrong', async () => {
    const slip = review({ status: 'mistake', box: [400, 100, 480, 600], wrongPart: '-2x', studentMessage: 'Check the sign on line 2.' });
    const fixed = rig({ reviews: [slip, review({ status: 'on_track' })] });
    await fixed.t.act({ type: 'readScreen' });
    await fixed.settle();
    expect(fixed.last().mark).not.toBeNull();
    expect(fixed.last().bubble?.quote).toBe('-2x');
    fixed.wait(3000);
    fixed.setPicture(40);
    await fixed.t.tick();
    expect(fixed.last().mark).toBeNull();
    fixed.wait(1500);
    await fixed.t.tick();
    await fixed.settle();
    expect(fixed.last().mark).toBeNull();
    expect(fixed.last().bubble?.title).toBe('Nice fix!');
    fixed.t.sleep();

    const still = rig({ reviews: [slip, slip] });
    await still.t.act({ type: 'readScreen' });
    await still.settle();
    const bubbleId = still.last().bubble?.id;
    still.wait(3000);
    still.setPicture(40);
    await still.t.tick();
    expect(still.last().mark).toBeNull();
    still.wait(1500);
    await still.t.tick();
    await still.settle();
    expect(still.last().mark).not.toBeNull();
    expect(still.last().bubble?.id).toBe(bubbleId);
    still.t.sleep();
  });

  it('never praises a fix on a read that saw no work: a misread keeps the square, two in a row take it down quietly', async () => {
    const slip = review({ status: 'mistake', box: [400, 100, 480, 600], studentMessage: 'Check the sign on line 2.' });
    const blank = review({ status: 'no_work', readability: 'nothing_written' });
    const r = rig({ reviews: [slip, blank, blank] });
    await r.t.act({ type: 'readScreen' });
    await r.settle();
    expect(r.last().mark).not.toBeNull();
    await r.t.act({ type: 'check' });
    await r.settle();
    expect(r.last().mark).not.toBeNull();
    await r.t.act({ type: 'check' });
    await r.settle();
    expect(r.last().mark).toBeNull();
    expect(r.states.some((x) => x.bubble?.title === 'Nice fix!')).toBe(false);
    r.t.sleep();
  });

  it('takes the square down when the slip is fixed, and does not re-show one the student closed', async () => {
    const slip = review({ status: 'mistake', box: [400, 100, 480, 600], studentMessage: 'Check the sign on line 2.' });
    const r = rig({ reviews: [slip, review({ status: 'on_track' }), slip] });
    await r.t.act({ type: 'readScreen' });
    await r.settle();
    expect(r.last().mark).not.toBeNull();
    await r.t.act({ type: 'check' });
    await r.settle();
    expect(r.last().mark).toBeNull();
    expect(r.last().bubble?.title).toBe('Nice fix!');
    r.t.sleep();

    const d = rig({ reviews: [slip, slip] });
    await d.t.act({ type: 'readScreen' });
    await d.settle();
    await d.t.act({ type: 'dismissMark' });
    d.wait(3000);
    d.setPicture(70);
    await d.t.tick();
    d.wait(1400);
    await d.t.tick();
    await d.settle();
    // It read the work again and saw the same slip, but the student had closed it.
    expect(d.calls.filter((c) => c.kind === 'review')).toHaveLength(2);
    expect(d.last().mark).toBeNull();
    d.t.sleep();
  });

  it('cheers when it is solved, once, and counts it', async () => {
    const r = rig({ reviews: [review({ status: 'solved', studentMessage: 'Yes! You remembered the inside.' })] });
    await r.t.act({ type: 'readScreen' });
    await r.settle();
    const s = r.last();
    expect(s.mood).toBe('cheer');
    expect(s.cheer).toBe(1);
    expect(s.solvedToday).toBe(1);
    expect(s.bubble?.text).toMatch(/You remembered the inside\. That's 1 solved today\./);
    expect(s.bubble?.actions.map((a) => a.id)).toEqual(['newProblem', 'sleep']);
    r.t.sleep();
  });
});

describe('only where it is showing', () => {
  it('does not read the work in an app tanrushu is not shown in', async () => {
    const r = rig();
    let allowed = true;
    (r.t as unknown as { d: { canWatch: () => boolean } }).d.canWatch = () => allowed;
    await r.t.act({ type: 'readScreen' });
    await r.settle();
    const reads = () => r.calls.filter((c) => c.kind === 'review').length;
    allowed = false;
    r.wait(3000);
    r.setPicture(90);
    await r.t.tick();
    r.wait(1400);
    await r.t.tick();
    await r.settle();
    expect(reads()).toBe(1);
    allowed = true;
    r.wait(700);
    await r.t.tick();
    r.wait(1400);
    await r.t.tick();
    await r.settle();
    expect(reads()).toBe(2);
    r.t.sleep();
  });
});

describe('asking for help', () => {
  it('hints go up a level each time and never repeat, and a missing basic gets its own video button', async () => {
    const r = rig();
    await r.t.act({ type: 'readScreen' });
    await r.settle();
    await r.t.act({ type: 'hint' });
    expect(r.last().bubble).toMatchObject({ kind: 'hint', title: 'Hint 1', text: 'hint at level 1' });
    await r.t.act({ type: 'another' });
    const second = r.calls.filter((c) => c.kind === 'hint')[1].arg as { action: string; minLevel: number; history: unknown[]; work: { image: string } };
    expect(second).toMatchObject({ action: 'another', minLevel: 2 });
    expect(second.history).toHaveLength(1);
    expect(second.work.image).toBe('JPEG1');
    expect(r.last().bubble?.actions.find((a) => a.id === 'videoFor')).toMatchObject({ label: 'Video: composite functions', arg: 'composite functions' });
    r.t.sleep();
  });

  it('shows the clip found in the background right away, at the minute that explains it', async () => {
    const r = rig();
    await r.t.act({ type: 'readScreen' });
    await r.settle();
    const t0 = Date.now();
    await r.t.act({ type: 'video' });
    expect(Date.now() - t0).toBeLessThan(500);
    const b = r.last().bubble!;
    expect(b.video).toMatchObject({ videoId: 'abcdefghijk', at: '1:15', url: 'https://www.youtube.com/watch?v=abcdefghijk&t=75s', refining: false });
    expect(b.actions[0]).toMatchObject({ id: 'watch', label: 'Watch it (1:15)' });
    await r.t.act({ type: 'watch', url: b.video!.url });
    expect(r.opened).toContain('https://www.youtube.com/watch?v=abcdefghijk&t=75s');
    // Searched once, when the problem was solved.
    expect(r.calls.filter((c) => c.kind === 'search')).toHaveLength(1);
    r.t.sleep();
  });

  it('never shows a video, a video button or a problem name that gives the answer away', async () => {
    const r = rig({ videoTitle: 'dy/dx of sin(3x^2) = 6x cos(3x^2)', prereq: '6x cos(3x^2)' });
    await r.t.act({ type: 'readScreen' });
    await r.settle();
    await r.t.act({ type: 'video' });
    expect(r.last().bubble?.video).toBeUndefined();
    expect(r.last().bubble?.title).toBe('No video found');
    await r.t.act({ type: 'hint' });
    await r.t.act({ type: 'another' });
    expect(r.last().bubble?.actions.some((a) => a.id === 'videoFor')).toBe(false);
    expect(JSON.stringify(r.states)).not.toContain('6x cos');
    r.t.sleep();

    // A 'which rule applies?' question: the method's name is the answer, so it isn't announced.
    const w = rig({ solve: async () => ({ ...KEY, problemText: 'Which rule do you use to differentiate sin(3x^2)?', finalAnswer: 'the chain rule', answerKeyPhrases: ['chain rule'] }) });
    await w.t.act({ type: 'readScreen' });
    await w.settle();
    expect(w.last().problem).toBe('this problem');
    expect(JSON.stringify(w.states)).not.toMatch(/chain rule/i);
    w.t.sleep();
  });

  it('asks for a SerpApi key before a video, and for the problem before a hint', async () => {
    const r = rig({ serp: false });
    await r.t.act({ type: 'readScreen' });
    await r.settle();
    await r.t.act({ type: 'video' });
    expect(r.last().bubble?.title).toMatch(/SerpApi key/);
    r.t.sleep();
    // Hint before the problem has been read: it reads it, then gives the hint.
    const n = rig();
    await n.t.act({ type: 'hint' });
    expect(n.calls.map((c) => c.kind).filter((k) => k === 'solve' || k === 'hint')).toEqual(['solve', 'hint']);
    expect(n.last().bubble?.title).toBe('Hint 1');
    n.t.sleep();
  });

  it('a button never goes dead: a second tap says it is still working, and a stuck hint gives up with Try again', async () => {
    let asked = 0;
    const r = rig({ hint: () => (asked++, new Promise(() => undefined)), busyLimitMs: 300 });
    await r.t.act({ type: 'readScreen' });
    await r.settle();
    void r.t.act({ type: 'hint' });
    await r.settle();
    expect(r.last().busy).toBe('hint');
    r.t.act({ type: 'dismissBubble' });
    await r.t.act({ type: 'hint' });
    expect(r.last().bubble?.pending).toBe(true);
    expect(asked).toBe(1);
    await new Promise((res) => setTimeout(res, 400));
    expect(r.last().busy).toBeNull();
    expect(r.last().bubble?.title).toBe('That took too long');
    expect(r.last().bubble?.actions.map((x) => x.id)).toEqual(['hint']);
    r.t.sleep();
  });

  it('waits for a read that is running, instead of starting another', async () => {
    let release: (v: SolverResult) => void = () => undefined;
    const r = rig({ solve: () => new Promise<SolverResult>((res) => (release = res)) });
    r.t.autoRead(WIN);
    await r.settle();
    expect(r.last().phase).toBe('reading');
    const hint = r.t.act({ type: 'hint' });
    await r.settle();
    expect(r.last().bubble?.title).toBe('Reading the problem first…');
    release(KEY);
    await hint;
    expect(r.last().bubble?.title).toBe('Hint 1');
    r.t.sleep();
  });

  it('a check the student asks for always answers, even when the work is fine so far', async () => {
    const r = rig({ reviews: [review({ status: 'no_work' }), review({ status: 'on_track', studentMessage: 'Your setup is right. Keep going.' })] });
    await r.t.act({ type: 'readScreen' });
    await r.settle();
    await r.t.act({ type: 'check' });
    const last = r.calls.filter((c) => c.kind === 'review').pop()?.arg as { final: boolean };
    expect(last.final).toBe(true);
    expect(r.last().bubble).toMatchObject({ kind: 'check', title: 'So far, so good', text: 'Your setup is right. Keep going.' });
    r.t.sleep();
  });

  it('drops answers that arrive after the student moved on to a new problem', async () => {
    let release: (v: SolverResult) => void = () => undefined;
    const slow = vi.fn(() => new Promise<SolverResult>((res) => (release = res)));
    const r = rig({ solve: slow });
    const first = r.t.act({ type: 'readScreen' });
    r.t.sleep();
    release(KEY);
    await first;
    expect(r.last().phase).toBe('asleep');
  });
});
