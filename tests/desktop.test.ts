import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { normalizeSolution, solverParts } from '../src/core/ai/solver';
import { courseBlock, normalizeTopics, topicsFromList } from '../src/core/ai/syllabus';
import { courseRuleBlock } from '../src/core/ai/tutor';
import { reviewParts } from '../src/core/ai/work';
import { chapterScore, clipUrl, clock, quickMoment, VideoFinder } from '../src/core/serp/videoFinder';
import { VideoCache } from '../src/core/serp/cache';
import type { VideoCandidate } from '../src/core/serp/youtube';
import type { SolverResult } from '../src/core/shared/types';
import { gateTick, initialGate, markRead, thumbDiff, regionChanged } from '../src/main/gate';
import { SettingsStore } from '../src/main/settings';
import { appName, markFor, overlap, sameProblem, writesAnswer } from '../src/main/tutorService';
import { isWorkCandidate } from '../src/main/workWindow';
import { closeUpRegion, cropRect, fromCloseUp } from '../src/main/captureMath';

const thumb = (v: number, n = 160 * 120) => new Uint8Array(n).fill(v);

describe('the watch gate', () => {
  it('reads once the work changed and then sat still', () => {
    let s = initialGate();
    const t0 = 10_000;
    // First tick: nothing read yet, the picture is new.
    let d = gateTick(s, thumb(10), t0, 0, false);
    expect(d.read).toBe(false); // it just changed: still being written
    s = d.state;
    d = gateTick(s, thumb(10), t0 + 700, 0, false);
    expect(d.read).toBe(false); // still for 0.7 s, not long enough
    s = d.state;
    d = gateTick(s, thumb(10), t0 + 1400, 2, false);
    expect(d.read).toBe(true); // still for 1.4 s and the hand is off the pen
    expect(d.why).toMatch(/sat still/);
    s = d.state;
    // Nothing new: no second read.
    d = gateTick(s, thumb(10), t0 + 5000, 5, false);
    expect(d.read).toBe(false);
    expect(d.why).toMatch(/nothing new/);
  });

  it('never reads while a read is running, or too soon after one', () => {
    let s = markRead(initialGate(), thumb(0), 0);
    s = gateTick(s, thumb(80), 3000, 0, false).state;
    expect(gateTick(s, thumb(80), 5000, 3, true).read).toBe(false);
    const soon = markRead(initialGate(), thumb(0), 4000);
    const s2 = gateTick(soon, thumb(80), 4100, 0, false).state;
    expect(gateTick(s2, thumb(80), 5500, 3, false).why).toMatch(/too soon/);
  });

  it('reads someone who writes without stopping, after a while', () => {
    let s = markRead(initialGate(), thumb(0), 0);
    let read = false;
    for (let t = 3000, i = 0; t < 30_000 && !read; t += 700, i++) {
      const d = gateTick(s, thumb(i % 2 ? 100 : 200), t, 0, false);
      s = d.state;
      read = d.read;
      if (read) expect(d.why).toMatch(/kept changing/);
    }
    expect(read).toBe(true);
  });

  it('ignores tiny changes (a blinking cursor, compression noise) but notices one new word', () => {
    const a = thumb(250);
    const cursor = thumb(250);
    for (let i = 0; i < 4; i++) cursor[1000 + i * 160] = 120;
    expect(thumbDiff(a, cursor)).toBeLessThan(0.0006);
    const noise = a.map((v, i) => v - (i % 3) * 5);
    expect(thumbDiff(a, noise)).toBe(0);
    // A short handwritten word: about 12 x 4 thumbnail pixels, darkened by the ink.
    const word = thumb(250);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 12; x++) word[(60 + y) * 160 + 40 + x] = 170;
    expect(thumbDiff(a, word)).toBeGreaterThan(0.0006);
    expect(thumbDiff(a, null)).toBe(1);
  });
});

describe('the red square', () => {
  it('lands on the same spot of the real window, in overlay coordinates', () => {
    const m = markFor([500, 250, 600, 750], { rectDip: { x: 100, y: 50, width: 800, height: 600 } }, { x: 0, y: 0 }, 1, 'Check this part');
    expect(m).toMatchObject({ x: 100 + 200 - 4, y: 50 + 300 - 4, width: 400 + 8, height: 60 + 8 });
    const onSecond = markFor([0, 0, 100, 100], { rectDip: { x: 2000, y: 0, width: 1000, height: 1000 } }, { x: 1920, y: 0 }, 2, '');
    expect(onSecond.x).toBe(80 - 4);
  });

  it('takes a close-up around a box with room to spare, and maps what is found in it back onto the window', () => {
    const region = closeUpRegion([500, 400, 520, 450]);
    // At least 20% wide and 17% tall, centred on the box, inside the window.
    expect(region).toEqual([425, 325, 595, 525]);
    // The piece found in the middle of the close-up is back where it is on the window.
    expect(fromCloseUp([400, 250, 600, 750], region)).toEqual([493, 375, 527, 475]);
    // A box at the edge: the close-up stays inside the window.
    expect(closeUpRegion([0, 980, 10, 1000])).toEqual([0, 800, 170, 1000]);
  });

  it('tells when the marked spot itself changed, not some other part of the page', () => {
    const before = new Uint8Array(160 * 120).fill(255);
    const elsewhere = before.slice();
    for (let x = 10; x < 30; x++) elsewhere[100 * 160 + x] = 0; // ink near the bottom left
    expect(regionChanged(before, elsewhere, [100, 500, 200, 900])).toBe(false);
    const there = before.slice();
    for (let x = 100; x < 110; x++) there[18 * 160 + x] = 0; // ink inside the box
    expect(regionChanged(before, there, [100, 500, 200, 900])).toBe(true);
  });

  it('knows when two reads found the same problem, even worded a little differently', () => {
    const p = { problemText: 'Problem 2a. Find dy/dx for y = sin(3x^2).' };
    expect(sameProblem(p, { problemText: 'Find dy/dx if y = sin(3x²)' })).toBe(true);
    expect(sameProblem(p, { problemText: 'Problem 2b. Find dy/dx for y = cos(5x^3).' })).toBe(false);
    const c = { problemText: 'Find the current through R2. R1 = 2 kΩ, R2 = 4 kΩ, V = 12 V.' };
    expect(sameProblem(c, { problemText: 'R1 = 2 kohm, R2 = 4 kohm and a 12 V source: find the current in R2.' })).toBe(true);
    expect(sameProblem(c, { problemText: 'Find the current through R2. R1 = 3 kΩ, R2 = 6 kΩ, V = 9 V.' })).toBe(false);
    expect(sameProblem(c, { problemText: '' })).toBe(false);
  });

  it('knows when the work ends with the right answer, in any of its accepted forms', () => {
    const identity = { problemText: 'Solve for x: 3x - 7 = 3x - 7', finalAnswer: 'all real numbers', answerForms: ['infinitely many solutions', 'x ∈ ℝ', 'identity', 'true for all x'] };
    expect(writesAnswer('3x - 7 = 3x - 7 / -7 = -7 / infinitely many solutions', identity)).toBe(true);
    expect(writesAnswer('3x-7=3x-7 / so infinitely many solutions.', identity)).toBe(true);
    expect(writesAnswer('-7 = -7 / All real numbers', identity)).toBe(true);
    expect(writesAnswer('3x - 7 = 3x - 7 / -7 = -7', identity)).toBe(false);
    expect(writesAnswer('', identity)).toBe(false);
    const linear = { problemText: 'Solve 2x + 3 = 11', finalAnswer: 'x = 4', answerForms: ['4'] };
    expect(writesAnswer('2x + 3 = 11 / 2x = 8 / x = 4', linear)).toBe(true);
    expect(writesAnswer('2x = 8', linear)).toBe(false);
    expect(writesAnswer('2x + 3 = 11 / x = 5', linear)).toBe(false);
    // A form that is in the problem itself proves nothing.
    expect(writesAnswer('2x + 3 = 11', { ...linear, answerForms: ['11'] })).toBe(false);
  });

  it('knows when two boxes are the same slip', () => {
    expect(overlap([100, 100, 200, 300], [110, 110, 205, 290])).toBeGreaterThan(0.7);
    expect(overlap([100, 100, 200, 300], [500, 500, 600, 600])).toBe(0);
  });

  it('cuts the window out of the display picture, even when it hangs off the edge', () => {
    expect(cropRect({ x: 100, y: 100, width: 800, height: 600 }, { x: 0, y: 0, width: 1920, height: 1080 }, 1)).toEqual({ x: 100, y: 100, width: 800, height: 600 });
    expect(cropRect({ x: 1800, y: 100, width: 800, height: 600 }, { x: 0, y: 0, width: 1920, height: 1080 }, 0.5)).toEqual({ x: 900, y: 50, width: 60, height: 300 });
    expect(cropRect({ x: 5000, y: 0, width: 300, height: 300 }, { x: 0, y: 0, width: 1920, height: 1080 }, 1)).toBeNull();
  });
});

describe('which window is the work', () => {
  const w = (o: Partial<Parameters<typeof isWorkCandidate>[0] & object> = {}) => ({ hwnd: 1, pid: 50, title: 'Notes - OneNote', cls: 'Framework::CFrame', rect: { x: 0, y: 0, width: 1200, height: 800 }, minimized: false, exe: 'onenote.exe', ...o });
  it('skips myTA itself, the taskbar and the desktop, and tiny or minimized windows', () => {
    const own = new Set([7]);
    expect(isWorkCandidate(w(), own)).toBe(true);
    expect(isWorkCandidate(w({ pid: 7 }), own)).toBe(false);
    expect(isWorkCandidate(w({ cls: 'Shell_TrayWnd' }), own)).toBe(false);
    expect(isWorkCandidate(w({ cls: 'Progman' }), own)).toBe(false);
    expect(isWorkCandidate(w({ minimized: true }), own)).toBe(false);
    expect(isWorkCandidate(w({ rect: { x: 0, y: 0, width: 120, height: 90 } }), own)).toBe(false);
    expect(isWorkCandidate(null, own)).toBe(false);
  });
  it('names the app for the status line', () => {
    expect(appName('Untitled - Paint')).toBe('Paint');
    expect(appName('Homework – OneNote')).toBe('OneNote');
    expect(appName('Problem set 3.pdf - Adobe Acrobat Reader (64-bit)')).toBe('Adobe Acrobat Reader (64-bit)');
    expect(appName('')).toBe('your notes');
  });
});

describe('course topics', () => {
  it('reads a pasted list without a model call', () => {
    expect(topicsFromList('1. limits\n2) derivatives\n- chain rule, implicit differentiation; related rates')).toEqual(['limits', 'derivatives', 'chain rule', 'implicit differentiation', 'related rates']);
  });
  it('tidies what the model says', () => {
    const t = normalizeTopics({ course: ' Calc I ', coveredUpTo: 'week 6', topics: ['Limits', 'limits', ' Chain   rule ', 3, ''] }, 5);
    expect(t).toEqual({ course: 'Calc I', coveredUpTo: 'week 6', topics: ['Limits', 'Chain rule'], updatedAt: 5 });
  });
  it('goes into every call that talks about methods, and nowhere when not given', () => {
    const c = { course: 'Circuits', coveredUpTo: 'through week 4', topics: ['Ohm\'s law', 'KCL'], updatedAt: 1 };
    expect(courseBlock(c)).toContain('- KCL');
    expect(courseRuleBlock(c)).toMatch(/Never suggest a method the course has not reached yet/);
    expect(courseBlock(null)).toBe('');
    expect(courseRuleBlock({ ...c, topics: [] })).toBe('');
  });
});

const KEY: SolverResult = {
  problemText: 'Find dy/dx for y = sin(3x^2)',
  finalAnswer: '6x cos(3x^2)',
  keySteps: ['outer sin', 'inner 3x^2'],
  conceptTags: ['chain rule'],
  misconceptions: [],
  answerKeyPhrases: ['6x cos'],
  problemDetected: true,
  domain: 'calculus',
};

describe('the answer key', () => {
  it('keeps the video search about the concept, never the problem', () => {
    const r = normalizeSolution({ problemDetected: true, problemText: 'Find dy/dx for y = sin(3x^2) at x equals one', conceptTags: ['chain rule'], videoConcept: 'chain rule', videoQuery: 'find dy/dx for y = sin(3x^2) at x equals one' });
    expect(r.videoQuery).toBe('chain rule explained');
    const ok = normalizeSolution({ problemDetected: true, problemText: 'x', conceptTags: ['chain rule'], videoConcept: '', videoQuery: '' });
    expect(ok.videoConcept).toBe('chain rule');
    expect(ok.videoQuery).toBe('chain rule explained');
  });

  it('sends the course, then the uploaded problem, then the screen', () => {
    const parts = solverParts({
      screen: 'SCREEN',
      upload: { data: 'PDF', mimeType: 'application/pdf', name: 'hw3.pdf' },
      which: '3b',
      course: { course: '', coveredUpTo: '', topics: ['chain rule'], updatedAt: 0 },
    });
    const kinds = parts.map((p) => ('text' in p ? 'text' : 'file' in p ? `file:${p.mimeType}` : 'image' in p ? 'image' : 'video'));
    expect(kinds).toEqual(['text', 'text', 'file:application/pdf', 'text', 'image', 'text']);
    expect((parts[0] as { text: string }).text).toMatch(/Course topics/);
    expect((parts[parts.length - 1] as { text: string }).text).toMatch(/"3b"/);
    // No course, no upload: just the screen.
    expect(solverParts({ screen: 'S' }).filter((p) => 'image' in p)).toHaveLength(1);
  });

  it('sends the uploaded problem to a work read only when asked to', () => {
    const base = { hidden: KEY, workImage: 'W', previous: '', final: false };
    expect(reviewParts({ ...base, problemFile: { data: 'P', mimeType: 'image/png' } }).some((p) => 'file' in p)).toBe(true);
    expect(reviewParts(base).some((p) => 'file' in p)).toBe(false);
    expect((reviewParts({ ...base, course: { course: '', coveredUpTo: '', topics: ['x'], updatedAt: 0 } })[0] as { text: string }).text).toMatch(/Course topics/);
  });
});

const cand = (id: string, o: Partial<VideoCandidate> = {}): VideoCandidate => ({ videoId: id, title: `Video ${id}`, channel: 'Khan Academy', lengthSec: 600, description: '', chapters: [], ...o });

describe('finding the clip fast', () => {
  it('starts at a chapter that names the concept, without a model call', () => {
    const m = quickMoment(
      [cand('aaaaaaaaaaa'), cand('bbbbbbbbbbb', { chapters: [{ title: 'Intro', startSec: 0 }, { title: 'The chain rule', startSec: 134 }, { title: 'Practice', startSec: 400 }] })],
      'chain rule',
    );
    expect(m).toMatchObject({ videoId: 'bbbbbbbbbbb', start: 134, end: 400, source: 'chapters' });
    expect(clock(134)).toBe('2:14');
    expect(clock(3723)).toBe('1:02:03');
    expect(clipUrl(m!)).toBe('https://www.youtube.com/watch?v=bbbbbbbbbbb&t=134s');
  });

  it('falls back to the top result from the start', () => {
    expect(quickMoment([cand('ccccccccccc')], 'node voltage analysis')).toMatchObject({ videoId: 'ccccccccccc', start: 0, source: 'metadata' });
    expect(quickMoment([], 'x')).toBeNull();
    expect(chapterScore('Node-voltage method', 'node voltage analysis')).toBeGreaterThan(0.5);
  });

  it('searches once, in the background, and improves the minute when Gemini finishes watching', async () => {
    let searches = 0;
    const store: Record<string, unknown> = {};
    const finder = new VideoFinder(
      new VideoCache({ get: async (k) => ({ [k]: store[k] }), set: async (i) => void Object.assign(store, i) }, {}),
      () => ({ serpKey: 'k', ctx: { apiKey: 'g', model: 'm' } }),
      {
        search: async () => {
          searches++;
          return [cand('ddddddddddd')];
        },
        watch: async () => ({ start: 185, end: 300, why: 'how it peels off the outer function' }),
      },
    );
    finder.prefetch('chain rule', 'chain rule explained');
    finder.prefetch('chain rule', 'chain rule explained');
    const quick = await finder.get('chain rule', 'chain rule explained');
    expect(quick?.videoId).toBe('ddddddddddd');
    const better = await finder.whenRefined('chain rule');
    expect(better).toMatchObject({ start: 185, source: 'video' });
    expect(searches).toBe(1);
    // Next time it comes straight from the cache.
    const again = new VideoFinder(new VideoCache({ get: async (k) => ({ [k]: store[k] }), set: async () => undefined }, {}), () => ({ serpKey: 'k', ctx: null }), {
      search: async () => {
        throw new Error('should not search');
      },
      watch: async () => null,
    });
    expect(await again.get('chain rule', '')).toMatchObject({ start: 185, source: 'cache' });
  });
});

describe('settings', () => {
  const dirs: string[] = [];
  const tempDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'myta-'));
    dirs.push(d);
    return d;
  };
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const crypto = { available: () => true, encrypt: (s: string) => `enc(${s})`, decrypt: (s: string) => s.slice(4, -1) };
  it('encrypts the keys and never shows them back', () => {
    const file = join(tempDir(), 'settings.json');
    const s = new SettingsStore(file, crypto);
    s.setKeys({ gemini: ' AIzaSECRET1234 ', serp: 'serpKEY9876' });
    expect(readFileSync(file, 'utf8')).not.toContain('AIzaSECRET1234"');
    expect(readFileSync(file, 'utf8')).toContain('enc(AIzaSECRET1234)');
    expect(new SettingsStore(file, crypto).geminiKey()).toBe('AIzaSECRET1234');
    const v = s.view();
    expect(v.gemini).toEqual({ saved: true, tail: '1234' });
    expect(JSON.stringify(v)).not.toContain('SECRET');
    // Changing one key keeps the other.
    s.setKeys({ serp: 'newSERP0000' });
    expect(s.geminiKey()).toBe('AIzaSECRET1234');
    expect(s.serpKey()).toBe('newSERP0000');
  });
  it('falls back to keys from the environment, and counts solved problems per day', () => {
    const file = join(tempDir(), 'settings.json');
    const s = new SettingsStore(file, crypto, { MYTA_GEMINI_KEY: 'envkey' });
    expect(s.geminiKey()).toBe('envkey');
    expect(s.solvedToday()).toBe(0);
    s.addSolved();
    expect(s.addSolved()).toBe(2);
    expect(new SettingsStore(file, crypto).solvedToday()).toBe(2);
  });
});

describe('only in note-taking and whiteboard apps', () => {
  const win = (title: string, exe: string, hwnd = 1) => ({ title, exe, hwnd });
  // Real window titles: what Windows reports for each app or browser tab.
  const SHOW: [string, string][] = [
    ['New ECE 406 H Notes - OneNote', 'onenote.exe'],
    ['Untitled - Paint', 'mspaint.exe'],
    ['Lab report - Word', 'winword.exe'],
    ['notes.txt - Notepad', 'notepad.exe'],
    ['hw3.pdf - Adobe Acrobat Reader (64-bit)', 'acrord32.exe'],
    ['Miro', 'miro.exe'],
    ['Lecture 5 - Google Docs - Google Chrome', 'chrome.exe'],
    ['Physics notes | Notion - Google Chrome', 'chrome.exe'],
    ['Untitled - Excalidraw - Google Chrome', 'chrome.exe'],
    ['Team board - Miro - Google Chrome', 'chrome.exe'],
    ['Desmos | Graphing Calculator - Google Chrome', 'chrome.exe'],
    ['Calc I - OneNote - Personal - Microsoft Edge', 'msedge.exe'],
    ['problem_set_4.pdf - Personal - Microsoft Edge', 'msedge.exe'],
    ['ece302_hw5.pdf - Google Chrome', 'chrome.exe'],
    ['Thesis - Overleaf, Online LaTeX Editor - Mozilla Firefox', 'firefox.exe'],
    ['Microsoft Whiteboard', 'applicationframehost.exe'],
    ['Calc - OneNote for Windows 10', 'applicationframehost.exe'],
  ];
  const HIDE: [string, string][] = [
    // The bug: a search, email or page that merely MENTIONS a notes app or a whiteboard.
    ['best online whiteboard for notes windows - Google Search - Google Chrome', 'chrome.exe'],
    ['Inbox (3) - tanushcpm@gmail.com - Gmail - Google Chrome', 'chrome.exe'],
    ['Re: Notion invite for the study group - tanushcpm@gmail.com - Gmail - Google Chrome', 'chrome.exe'],
    ['How to use OneNote for school - YouTube - Google Chrome', 'chrome.exe'],
    ['Miro vs Excalidraw: which whiteboard? - Reddit - Google Chrome', 'chrome.exe'],
    ['Word of the day - Google Chrome', 'chrome.exe'],
    ['Notion - Google Search - Google Chrome', 'chrome.exe'],
    ['Whiteboard - tanushcpm@gmail.com - Gmail - Google Chrome', 'chrome.exe'],
    ['OneNote - YouTube - Google Chrome', 'chrome.exe'],
    ['Miro - Wikipedia - Google Chrome', 'chrome.exe'],
    ['How to paint a wall - YouTube - Google Chrome', 'chrome.exe'],
    ['New Tab - Google Chrome', 'chrome.exe'],
    ['New Tab - Norton Private Browser', 'nortonbrowser.exe'],
    ['laptop dont fall asleep - Search and 1 more page - Personal - Microsoft\u200b Edge', 'msedge.exe'],
    ['Inbox - Agrawal, Tanush - Outlook', 'olk.exe'],
    ['Spotify Premium', 'spotify.exe'],
    ['Claude', 'claude.exe'],
    ['Latest version from main - HackTX-2026-Gongoleers - Visual Studio Code', 'code.exe'],
    ['C:\\Windows\\system32\\cmd.exe', 'windowsterminal.exe'],
    ['Settings', 'applicationframehost.exe'],
    ['', 'explorer.exe'],
  ];

  it.each(SHOW)('shows in "%s"', async (title, exe) => {
    const { isNotesApp } = await import('../src/main/notesApps');
    expect(isNotesApp(win(title, exe))).toBe(true);
  });

  it.each(HIDE)('stays away from "%s"', async (title, exe) => {
    const { isNotesApp } = await import('../src/main/notesApps');
    expect(isNotesApp(win(title, exe))).toBe(false);
  });

  it('a hand call sticks to that window and tab only; "every app" shows it everywhere', async () => {
    const { showFor } = await import('../src/main/notesApps');
    const gmail = win('Inbox (3) - tanushcpm@gmail.com - Gmail - Google Chrome', 'chrome.exe', 42);
    const youtube = win('Lo-fi beats - YouTube - Google Chrome', 'chrome.exe', 42);
    expect(showFor(gmail, { everywhere: false, calledOn: null })).toBe(false);
    expect(showFor(gmail, { everywhere: false, calledOn: { hwnd: 42, title: gmail.title } })).toBe(true);
    // Another tab in the same Chrome window: not the one it was called on.
    expect(showFor(youtube, { everywhere: false, calledOn: { hwnd: 42, title: gmail.title } })).toBe(false);
    expect(showFor(win('Inbox - Outlook', 'olk.exe', 43), { everywhere: false, calledOn: { hwnd: 42, title: gmail.title } })).toBe(false);
    expect(showFor(youtube, { everywhere: true, calledOn: null })).toBe(true);
    expect(showFor(null, { everywhere: false, calledOn: null })).toBe(false);
  });
});

describe('the window in front', () => {
  it('follows whatever is in front, except myTA itself', async () => {
    const { WorkWindowTracker } = await import('../src/main/workWindow');
    const notes = { hwnd: 1, pid: 10, title: 'Calc - OneNote', cls: 'x', rect: { x: 0, y: 0, width: 1200, height: 800 }, minimized: false, exe: 'onenote.exe' };
    const desktop = { ...notes, hwnd: 2, pid: 11, title: '', cls: 'Progman', exe: 'explorer.exe' };
    const myta = { ...notes, hwnd: 3, pid: 99, title: 'myTA', exe: 'electron.exe' };
    let now: typeof notes | null = notes;
    const fronts: (string | null)[] = [];
    const t = new WorkWindowTracker(() => now, () => new Set([99]), undefined, (w) => fronts.push(w ? w.title || w.cls : null));
    t.poll();
    expect(t.inFront()?.title).toBe('Calc - OneNote');
    // Clicking tanrushu: still "in" the notes app.
    now = myta;
    t.poll();
    expect(t.inFront()?.title).toBe('Calc - OneNote');
    // The desktop: in front now (the work window is still remembered for later).
    now = desktop;
    t.poll();
    expect(t.inFront()?.cls).toBe('Progman');
    expect(t.current()?.title).toBe('Calc - OneNote');
    // Minimizing the notes counts as a change.
    now = { ...notes, minimized: true };
    t.poll();
    expect(t.inFront()?.minimized).toBe(true);
    now = null;
    t.poll();
    expect(t.inFront()).toBeNull();
    expect(fronts).toEqual(['Calc - OneNote', 'Progman', 'Calc - OneNote', null]);
  });
});

describe('browser tabs, by their web address', () => {
  const tab = (title: string, url?: string) => ({ title: `${title} - Google Chrome`, exe: 'chrome.exe', url });
  const SHOW: [string, string | undefined][] = [
    // The tab that was missed: an online whiteboard we don't know by name, with and without its address.
    ['Whiteboard for Online Collaboration | Web Whiteboard', 'webwhiteboard.com'],
    ['Whiteboard for Online Collaboration | Web Whiteboard', undefined],
    ['Online Whiteboard', undefined],
    ['Untitled board', 'miro.com/app/board/uXjVK123='],
    ['My board', 'https://excalidraw.com/#room=abc'],
    ['Lecture 5', 'https://docs.google.com/document/d/1abc/edit'],
    ['Circuit sketch', 'docs.google.com/drawings/d/9xyz/edit'],
    ['Keep', 'keep.google.com/u/0/'],
    ['Page', 'www.notion.so/Physics-notes-123'],
    ['Graphing Calculator', 'www.desmos.com/calculator'],
    ['Project', 'www.overleaf.com/project/abc'],
    ['Board', 'whiteboard.office.com/me/whiteboards/abc'],
    ['FigJam board', 'www.figma.com/board/abc/Study'],
    ['hw5', 'https://canvas.utexas.edu/files/123/download/hw5.pdf'],
    ['ECE 302 - Notebook', 'onenote.officeapps.live.com/o/onenoteframe.aspx'],
    ['Untitled', 'app.diagrams.net'],
  ];
  const HIDE: [string, string | undefined][] = [
    ['best online whiteboard for notes windows - Google Search', 'www.google.com/search?q=best+online+whiteboard'],
    ['Whiteboard tutorial - YouTube', 'www.youtube.com/watch?v=abc'],
    ['Notion invite - tanushcpm@gmail.com - Gmail', 'mail.google.com/mail/u/0/#inbox'],
    ['Budget', 'docs.google.com/spreadsheets/d/1abc/edit'],
    ['Best whiteboard apps for students - The Verge', 'www.theverge.com/whiteboard-apps'],
    ['Best whiteboard apps for students - The Verge', undefined],
    ['Design file', 'www.figma.com/design/abc/Landing'],
    ['ChatGPT', 'chatgpt.com'],
    ['Amazon.com: whiteboard markers', 'www.amazon.com/s?k=whiteboard+markers'],
    ['New Tab', undefined],
  ];
  it.each(SHOW)('shows on "%s" (%s)', async (title, url) => {
    const { isNotesApp } = await import('../src/main/notesApps');
    expect(isNotesApp(tab(title, url))).toBe(true);
  });
  it.each(HIDE)('hides on "%s" (%s)', async (title, url) => {
    const { isNotesApp } = await import('../src/main/notesApps');
    expect(isNotesApp(tab(title, url))).toBe(false);
  });
  it('reads what the address bar shows, with or without https://', async () => {
    const { parseAddress } = await import('../src/main/browserUrl');
    expect(parseAddress('webwhiteboard.com')?.hostname).toBe('webwhiteboard.com');
    expect(parseAddress('https://docs.google.com/document/d/1/edit')?.pathname).toBe('/document/d/1/edit');
    expect(parseAddress('file:///C:/Users/me/hw.pdf')?.protocol).toBe('file:');
    expect(parseAddress('best online whiteboard')).toBeNull();
    expect(parseAddress('')).toBeNull();
  });
  it('a desktop notes app is decided by its program, whatever the address', async () => {
    const { isNotesApp } = await import('../src/main/notesApps');
    expect(isNotesApp({ title: 'Inbox - Outlook', exe: 'olk.exe', url: 'miro.com' })).toBe(false);
    expect(isNotesApp({ title: 'Calc - OneNote', exe: 'onenote.exe' })).toBe(true);
  });
});
