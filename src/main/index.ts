// myTA desktop: a pixel monkey that floats over whatever app you take notes or do homework in (OneNote, a PDF, a whiteboard, Word, a
// browser...). It reads the problem by itself, watches your work, puts a red square on a slip, and gives hints and videos without ever
// giving the answer.
//
// Windows: the dock (tanrushu, its tools and speech bubble: sized to what it shows, always on top, never takes focus), the marks layer
// (the whole display, click-through, for the red square and confetti), setup, and the small "set the problem" window. Both overlay
// windows are left out of screen captures.
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, powerMonitor, safeStorage, screen, session, shell, Tray, type Rectangle } from 'electron';
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkGemini, checkSerp, fingerprint, listModelIds, pickBackupModels, pickFastModel } from '../core/ai/keyCheck';
import type { LlmCtx } from '../core/ai/llmClient';
import type { ProblemUpload } from '../core/ai/solver';
import { readSyllabus, topicsFromList, normalizeTopics } from '../core/ai/syllabus';
import { mergeTopics, newClass, normalizeClass, resolveClass, toCourse, upsertClass, type ActiveClass, type ClassInfo } from '../core/shared/classes';
import { VideoCache } from '../core/serp/cache';
import { VideoFinder } from '../core/serp/videoFinder';
import { RateLimiter } from '../core/shared/rateLimiter';
import type { MySprite, OverlayAction, SpritePos, UiState } from '../core/shared/ui';
import { fileScreen, realScreen, type ScreenSource } from './capture';
import { installE2eFetch } from './e2eFakes';
import { BrowserUrlReader } from './browserUrl';
import { BROWSERS, showFor, type CalledOn } from './notesApps';
import { HOTKEY, SettingsStore } from './settings';
import { AUTO_READ_DELAY_MS } from '../core/shared/constants';
import { TutorService } from './tutorService';
import { foregroundWindow, type WinInfo } from './win32';
import { WorkWindowTracker } from './workWindow';

const here = dirname(fileURLToPath(import.meta.url));
const E2E = process.env.MYTA_E2E === '1';
const SELFTEST = process.argv.includes('--selftest');
const LIVETEST = process.argv.includes('--livetest');
if (process.env.MYTA_USER_DATA) app.setPath('userData', process.env.MYTA_USER_DATA);
// Windows groups myTA's windows under this id, so the taskbar shows the book instead of Electron's icon.
if (process.platform === 'win32') app.setAppUserModelId('tech.myta.desktop');
if (E2E) installE2eFetch(process.env.MYTA_E2E_SCRIPT ?? '', process.env.MYTA_E2E_LOG ?? '');

const e2eLog = (line: string) => {
  if (E2E && process.env.MYTA_E2E_LOG) appendFileSync(process.env.MYTA_E2E_LOG, `${JSON.stringify({ t: Date.now(), event: line })}\n`);
  else if (!E2E) activity(line);
};

/** What tanrushu did and how long it took (never keys, problems or answers), in activity.log next to the settings, for finding problems. */
let activityFile = '';
function activity(line: string) {
  try {
    if (!activityFile) {
      activityFile = join(app.getPath('userData'), 'activity.log');
      if (existsSync(activityFile) && statSync(activityFile).size > 512 * 1024) writeFileSync(activityFile, '');
    }
    appendFileSync(activityFile, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging never gets in the way */
  }
}

if (!SELFTEST && !LIVETEST && !app.requestSingleInstanceLock()) app.quit();

let overlay: BrowserWindow | null = null;
let marks: BrowserWindow | null = null;
let setupWin: BrowserWindow | null = null;
let problemWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let settings: SettingsStore;
let tutor: TutorService;
let tracker: WorkWindowTracker;
let screenSrc: ScreenSource;
let pendingUpload: ProblemUpload | null = null;
let limiter: RateLimiter;

const preload = join(here, '../preload/index.cjs');
/** The light brown pixel book: the icon of every myTA window, the taskbar and the tray. */
const ICON = join(here, '../../resources/icon.ico');
function pageUrl(win: BrowserWindow, page: 'overlay' | 'marks' | 'settings' | 'camera') {
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${page}/index.html`);
  else void win.loadFile(join(here, `../renderer/${page}/index.html`));
}

// ---------------- the LLM context ----------------

/** The models this key can use (a free call, made once per key), so a busy quick model has others to fall back on. */
let modelIds: string[] = [];
let modelIdsFor = '';
function knownModels(apiKey: string): string[] {
  const fp = fingerprint(apiKey);
  if (modelIdsFor !== fp) {
    modelIdsFor = fp;
    modelIds = [];
    void listModelIds(apiKey).then((ids) => {
      if (modelIdsFor !== fp) return;
      if (ids) modelIds = ids;
      else modelIdsFor = ''; // offline: try again on the next call
    });
  }
  return modelIds;
}

function llm(): LlmCtx | null {
  const apiKey = settings.geminiKey();
  if (!apiKey) return null;
  const s = settings.raw;
  return {
    apiKey,
    model: s.model,
    smartModel: s.solverModel,
    backupModels: pickBackupModels(knownModels(apiKey), s.model),
    limiter,
    onCall: (c) => e2eLog(`gemini ${c.kind} ${c.model} ${c.ok ? 'ok' : 'failed'} ${c.ms} ms, ${c.promptTokens ?? '?'} in / ${c.completionTokens ?? '?'} out`),
    onModelMissing: async () => {
      const ids = await listModelIds(apiKey).catch(() => null);
      const alt = ids ? pickFastModel(ids) : null;
      if (alt) settings.update({ model: alt });
      return alt;
    },
  };
}

// ---------------- tanrushu's window and the marks layer ----------------
//
// tanrushu has its own small window, exactly as big as the monkey, its options and its speech bubble. It is never click-through, so a
// click, a tap, a double-tap or a pen tap on it always lands, and it never takes the keyboard from the notes app (it can't be focused).
// The red square and the confetti are drawn on a second, see-through window over the whole screen that never takes a click.

/** The display tanrushu is on: the one the work window is on, else the one with the mouse. */
function overlayDisplay(win: WinInfo | null) {
  if (win) return screen.getDisplayMatching(screenSrc.toDip(win.rect));
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

const DEFAULT_POS: SpritePos = { right: 24, bottom: 16 };
/** What tanrushu's window holds, as its page last reported it: total size, and where the monkey's column sits in it. */
let dockSize = { w: 230, h: 260, stackLeft: 0, stackWidth: 230 };
/** Where tanrushu was when a drag started. */
let dragFrom: SpritePos | null = null;
/** Where it is while being dragged (saved when the drag ends). */
let livePos: SpritePos | null = null;
let side: 'left' | 'right' = 'left';

const baseWindow = {
  transparent: true,
  frame: false,
  resizable: false,
  minimizable: false,
  maximizable: false,
  fullscreenable: false,
  focusable: false,
  skipTaskbar: true,
  hasShadow: false,
  alwaysOnTop: true,
  show: false,
  icon: ICON,
  backgroundColor: '#00000000',
} as const;

function createOverlay() {
  const d = overlayDisplay(tracker.current());
  overlay = new BrowserWindow({ ...baseWindow, width: dockSize.w, height: dockSize.h, movable: true, title: 'myTA', webPreferences: { preload, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setContentProtection(settings.raw.hideFromCapture);
  overlay.once('ready-to-show', () => {
    layoutDock();
    updateVisibility();
  });
  overlay.on('closed', () => (overlay = null));
  pageUrl(overlay, 'overlay');

  marks = new BrowserWindow({ ...baseWindow, ...d.bounds, movable: false, title: 'myTA marks', webPreferences: { preload, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  marks.setAlwaysOnTop(true, 'screen-saver');
  marks.setIgnoreMouseEvents(true);
  marks.setContentProtection(settings.raw.hideFromCapture);
  marks.once('ready-to-show', () => updateVisibility());
  marks.on('closed', () => (marks = null));
  pageUrl(marks, 'marks');
}

/** Keeps tanrushu on the screen: at least 60 px of it stays inside the work area (above the taskbar). */
function clampPos(p: SpritePos, wa: Rectangle): SpritePos {
  const keep = 60;
  return {
    right: Math.min(wa.width - keep, Math.max(-(dockSize.stackWidth - keep), p.right)),
    bottom: Math.min(wa.height - keep, Math.max(0, p.bottom)),
  };
}

/**
 * Puts tanrushu's window where it belongs: its monkey column `pos.right` from the right edge of the work area and its bottom `pos.bottom`
 * above the taskbar, sized to what it holds. The bubble opens on whichever side has room.
 */
function layoutDock() {
  if (!overlay) return;
  const d = overlayDisplay(tracker.current());
  const wa = d.workArea;
  const pos = clampPos(livePos ?? settings.raw.spritePos ?? DEFAULT_POS, wa);
  const columnRight = wa.x + wa.width - pos.right;
  const wantSide: 'left' | 'right' = columnRight - dockSize.stackWidth - wa.x >= 360 ? 'left' : 'right';
  if (wantSide !== side) {
    side = wantSide;
    overlay.webContents.send('ui:side', side);
  }
  const x = columnRight - (dockSize.stackLeft + dockSize.stackWidth);
  const y = wa.y + wa.height - pos.bottom - dockSize.h;
  const b = { x: Math.round(x), y: Math.round(Math.max(wa.y, y)), width: Math.max(60, dockSize.w), height: Math.max(60, dockSize.h) };
  const now = overlay.getBounds();
  if (now.x !== b.x || now.y !== b.y || now.width !== b.width || now.height !== b.height) overlay.setBounds(b);
  if (marks) {
    const mb = marks.getBounds();
    if (mb.x !== d.bounds.x || mb.y !== d.bounds.y || mb.width !== d.bounds.width || mb.height !== d.bounds.height) marks.setBounds(d.bounds);
    marks.webContents.send('marks:dock', { x: b.x - d.bounds.x, y: b.y - d.bounds.y, width: b.width, height: b.height });
  }
}

/** The window the student called tanrushu on with the hotkey or the tray (so it shows there even if it isn't a notes app). */
let calledOn: CalledOn | null = null;

/**
 * Whether tanrushu should be on screen: only while the window really in front is a notes or whiteboard app (or one it was called on by
 * hand). Minimizing the notes, clicking the desktop or the taskbar, or switching to any other app hides it.
 */
function shouldShow(): boolean {
  const front = tracker.inFront();
  if (!front || front.minimized) return false;
  return showFor(withUrl(front), { everywhere: settings.raw.showEverywhere, calledOn });
}

// ---- the address of the browser tab in front ----
const urlReader = new BrowserUrlReader();
/** Addresses read so far, by window and tab title (a new tab or page has a new title, so it's read again). */
const urls = new Map<string, string>();
const reading = new Set<string>();
const urlKey = (w: WinInfo) => `${w.hwnd}|${w.title}`;

/** The window, with the address of its tab when it's a browser and the address is known. Starts reading it when it isn't. */
function withUrl(w: WinInfo): WinInfo & { url?: string } {
  if (E2E || !BROWSERS.has(w.exe)) return w;
  const key = urlKey(w);
  const url = urls.get(key);
  if (url === undefined && !reading.has(key)) {
    reading.add(key);
    void urlReader.read(w.hwnd).then((u) => {
      reading.delete(key);
      if (urls.size > 300) urls.clear();
      urls.set(key, u);
      updateVisibility();
    });
  }
  return url ? { ...w, url } : w;
}

/** The notes window tanrushu last offered to read by itself, and the timer for it. */
let autoReadTimer: ReturnType<typeof setTimeout> | null = null;

function updateVisibility() {
  const show = shouldShow();
  if (overlay && show !== overlay.isVisible()) e2eLog(`${show ? 'shown on' : 'hidden for'} ${tracker.inFront()?.exe ?? 'nothing'}`);
  for (const w of [overlay, marks]) {
    if (!w) continue;
    if (show && !w.isVisible()) {
      w.showInactive();
      // Windows forgets a window is left out of screen captures when it is hidden, and only takes the setting from a window that is
      // showing: set again on every show, or tanrushu reads its own bubble and red square as part of the work.
      w.setContentProtection(settings.raw.hideFromCapture);
    }
    else if (!show && w.isVisible()) w.hide();
  }
  if (show) layoutDock();
  // On a notes window, read its problem by itself after a moment (not while the student is just flicking past windows).
  if (autoReadTimer) clearTimeout(autoReadTimer);
  autoReadTimer = null;
  const front = tracker.inFront();
  tutor?.frontChanged(show ? front : null);
  if (show && front && tutor) {
    autoReadTimer = setTimeout(() => {
      autoReadTimer = null;
      const still = tracker.inFront();
      if (still && still.hwnd === front.hwnd && shouldShow()) tutor.autoRead(still);
    }, AUTO_READ_DELAY_MS);
  }
}

/** Called from the hotkey, the tray or a second launch: show tanrushu on the current window, whatever app it is, and say hello. */
function callHere() {
  const w = tracker.inFront() ?? tracker.current();
  calledOn = w ? { hwnd: w.hwnd, title: w.title } : null;
  updateVisibility();
  void tutor.act({ type: 'call' });
}

function moveOverlayTo(_win: WinInfo) {
  layoutDock();
}

let lastState: UiState | null = null;
function emit(s: UiState) {
  lastState = s;
  overlay?.webContents.send('ui:state', s);
  marks?.webContents.send('ui:state', s);
  e2eLog(`state ${s.phase} ${s.busy ?? '-'} ${s.bubble ? `${s.bubble.kind}:${s.bubble.pending ? 'pending' : 'ready'}` : 'no-bubble'} ${s.mark ? 'mark' : 'no-mark'}`);
}

// ---------------- other windows ----------------

function openSetup() {
  if (setupWin && !setupWin.isDestroyed()) return setupWin.focus();
  setupWin = new BrowserWindow({ width: 1080, height: 860, minWidth: 720, minHeight: 600, title: 'myTA Setup', icon: ICON, autoHideMenuBar: true, backgroundColor: '#fbf6ea', webPreferences: { preload, contextIsolation: true, sandbox: true } });
  setupWin.on('closed', () => (setupWin = null));
  pageUrl(setupWin, 'settings');
}

function openProblem() {
  if (problemWin && !problemWin.isDestroyed()) return problemWin.focus();
  pendingUpload = null;
  problemWin = new BrowserWindow({ width: 560, height: 720, minWidth: 480, minHeight: 560, title: 'Set the problem', icon: ICON, autoHideMenuBar: true, backgroundColor: '#f7f6fd', alwaysOnTop: true, webPreferences: { preload, contextIsolation: true, sandbox: true } });
  problemWin.on('closed', () => (problemWin = null));
  pageUrl(problemWin, 'camera');
}

// ---------------- files ----------------

const MIME: Record<string, string> = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.heic': 'image/heic' };
const MAX_FILE = 18 * 1024 * 1024;

async function pickFile(parent: BrowserWindow | null, title: string): Promise<ProblemUpload | { error: string } | null> {
  let path = E2E ? process.env.MYTA_E2E_UPLOAD : undefined;
  if (!path) {
    const r = parent
      ? await dialog.showOpenDialog(parent, { title, properties: ['openFile'], filters: [{ name: 'Photos and PDFs', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'heic'] }] })
      : await dialog.showOpenDialog({ title, properties: ['openFile'], filters: [{ name: 'Photos and PDFs', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'heic'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    path = r.filePaths[0];
  }
  const mimeType = MIME[extname(path).toLowerCase()];
  if (!mimeType) return { error: 'That file type isn\'t supported. Use a PDF or a photo (PNG, JPG, WebP).' };
  const buf = readFileSync(path);
  if (buf.length > MAX_FILE) return { error: 'That file is too big (over 18 MB). Try a smaller PDF or a photo of just the problem.' };
  return { data: buf.toString('base64'), mimeType, name: basename(path) };
}

function dataUrlToUpload(dataUrl: string, name: string): ProblemUpload | null {
  const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(dataUrl);
  return m ? { mimeType: m[1], data: m[2], name } : null;
}

// ---------------- IPC ----------------

function wireIpc() {
  ipcMain.handle('ui:get', () => ({ state: tutor.state(), classes: classInfo(), sprite: settings.raw.sprite, side }));
  ipcMain.handle('marks:get', () => {
    const b = overlay?.getBounds();
    const m = marks?.getBounds();
    return { state: tutor.state(), dock: b && m ? { x: b.x - m.x, y: b.y - m.y, width: b.width, height: b.height } : null };
  });
  // The marks layer takes clicks only on the square's label (to close it) and its thin frame: the window is cut to that shape, so a
  // click anywhere else, inside the square too, goes through to the app underneath. With no square it takes no clicks at all.
  ipcMain.on('marks:hit', (_e, rects: { x: number; y: number; width: number; height: number }[] | null) => {
    if (!marks) return;
    const parts = (rects ?? []).filter((r) => r.width > 0 && r.height > 0).map((r) => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }));
    if (parts.length) {
      marks.setShape(parts);
      marks.setIgnoreMouseEvents(false);
    } else {
      marks.setIgnoreMouseEvents(true);
      marks.setShape([]);
    }
  });
  ipcMain.on('dock:size', (_e, sz: typeof dockSize) => {
    dockSize = sz;
    layoutDock();
  });
  ipcMain.on('dock:drag', (_e, d: { dx: number; dy: number; end: boolean }) => {
    const from = (dragFrom ??= settings.raw.spritePos ?? DEFAULT_POS);
    livePos = { right: from.right - d.dx, bottom: from.bottom - d.dy };
    layoutDock();
    if (d.end) {
      const wa = overlayDisplay(tracker.current()).workArea;
      settings.update({ spritePos: clampPos(livePos, wa) });
      livePos = null;
      dragFrom = null;
    }
  });
  ipcMain.on('ui:act', (_e, a: OverlayAction) => void tutor.act(a));

  ipcMain.handle('settings:get', () => settings.view());
  ipcMain.handle('settings:saveKeys', async (_e, k: { gemini?: string; serp?: string; model?: string; solverModel?: string }) => {
    settings.setKeys({ gemini: k.gemini, serp: k.serp });
    if (k.model?.trim() || k.solverModel?.trim()) settings.update({ model: k.model?.trim() || settings.raw.model, solverModel: k.solverModel?.trim() || settings.raw.solverModel });
    tutor.refresh();
    return settings.view();
  });
  ipcMain.handle('settings:test', async () => {
    const [g, s] = await Promise.all([checkGemini(settings.geminiKey(), settings.raw.model, settings.raw.solverModel), checkSerp(settings.serpKey())]);
    // Use what the key actually has, so a stale default never stops myTA from working.
    if (g.suggestedModel) settings.update({ model: g.suggestedModel });
    if (g.suggestedSolverModel) settings.update({ solverModel: g.suggestedSolverModel });
    return { gemini: g, serp: s, view: settings.view() };
  });
  // ---- classes ----
  ipcMain.handle('classes:add', (_e, name: string) => {
    const c = newClass(name, settings.raw.classes);
    settings.update({ classes: upsertClass(settings.raw.classes, c) });
    classesChanged();
    return { view: settings.view(), id: c.id };
  });
  ipcMain.handle('classes:save', (_e, c: ClassInfo) => {
    if (!settings.raw.classes.some((x) => x.id === c.id)) return settings.view();
    settings.update({ classes: upsertClass(settings.raw.classes, normalizeClass(c)) });
    classesChanged();
    return settings.view();
  });
  ipcMain.handle('classes:delete', (_e, id: string) => {
    settings.update({ classes: settings.raw.classes.filter((c) => c.id !== id), activeClass: settings.raw.activeClass === id ? 'auto' : settings.raw.activeClass });
    classesChanged();
    return settings.view();
  });
  ipcMain.handle('classes:active', (_e, id: ActiveClass) => setActiveClass(id));
  ipcMain.on('ui:setClass', (_e, id: ActiveClass) => void setActiveClass(id));
  // Reads a syllabus (a file the student dropped or chose, and/or pasted text) and adds the topics it finds to one class.
  ipcMain.handle('classes:readSyllabus', async (_e, input: { classId: string; text: string; upTo: string; file?: { name: string; mimeType: string; data: string } | null }) => {
    const c = settings.raw.classes.find((x) => x.id === input.classId);
    if (!c) return { error: 'That class is gone.' };
    const ctx = llm();
    try {
      let found;
      if (!input.file && !ctx) found = normalizeTopics({ topics: topicsFromList(input.text), coveredUpTo: input.upTo });
      else if (!ctx) return { error: 'Add your Gemini key first, so I can read the syllabus.' };
      else {
        if (input.file && !SYLLABUS_TYPES.has(input.file.mimeType)) return { error: 'Use a PDF or a photo (PNG, JPG, WebP).' };
        if (input.file && input.file.data.length > MAX_FILE * 1.37) return { error: 'That file is too big (over 18 MB).' };
        found = await readSyllabus(ctx, { text: input.text, file: input.file ?? null, upTo: input.upTo });
      }
      if (!found.topics.length) return { error: "I couldn't find any topics in that. Try pasting them one per line." };
      const fresh = settings.raw.classes.find((x) => x.id === input.classId) ?? c;
      const merged = normalizeClass({ ...fresh, topics: mergeTopics(fresh.topics, found.topics), coveredUpTo: found.coveredUpTo || fresh.coveredUpTo || input.upTo, name: fresh.name === 'New class' && found.course ? found.course : fresh.name });
      settings.update({ classes: upsertClass(settings.raw.classes, merged) });
      classesChanged();
      return { view: settings.view(), found: found.topics };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('settings:paste', () => clipboard.readText().trim().slice(0, 400));
  ipcMain.handle('settings:open', (_e, url: string) => {
    // Only the two pages where the keys come from.
    if (/^https:\/\/(aistudio\.google\.com|serpapi\.com)\//.test(url)) void shell.openExternal(url);
  });
  ipcMain.handle('settings:sprite', (_e, s: MySprite) => {
    settings.update({ sprite: { ...s, updatedAt: Date.now() } });
    overlay?.webContents.send('ui:sprite', settings.raw.sprite);
    return settings.view();
  });
  ipcMain.handle('settings:showEverywhere', (_e, on: boolean) => {
    settings.update({ showEverywhere: on });
    updateVisibility();
    return settings.view();
  });
  ipcMain.handle('settings:hideFromCapture', (_e, on: boolean) => {
    settings.update({ hideFromCapture: on });
    overlay?.setContentProtection(on);
    marks?.setContentProtection(on);
    return settings.view();
  });

  ipcMain.handle('problem:pick', async (e) => {
    const f = await pickFile(BrowserWindow.fromWebContents(e.sender), 'Choose the problem (photo or PDF)');
    if (!f || 'error' in f) return f;
    pendingUpload = f;
    const preview = f.mimeType.startsWith('image/') ? `data:${f.mimeType};base64,${f.data}` : null;
    return { name: f.name, kind: f.mimeType === 'application/pdf' ? 'pdf' : 'image', preview, sizeKb: Math.round((f.data.length * 3) / 4 / 1024) };
  });
  ipcMain.handle('problem:submit', async (_e, p: { which: string; photo?: string; useFile: boolean }) => {
    const upload = p.photo ? dataUrlToUpload(p.photo, 'photo of the problem') : p.useFile ? pendingUpload : null;
    if (!upload) return { error: 'Choose a file or take a photo first.' };
    problemWin?.close();
    void tutor.setProblem(upload, p.which, p.photo ? 'photo' : 'upload');
    return { ok: true };
  });
  ipcMain.handle('problem:screen', async (_e, p: { which: string }) => {
    problemWin?.close();
    void tutor.setProblem(null, p.which, 'screen');
    return { ok: true };
  });
}

const SYLLABUS_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic']);

/** The class in use right now, for the overlay's status line and menu. */
function classInfo() {
  const inUse = resolveClass(settings.raw.classes, settings.raw.activeClass, tracker.current()?.title ?? '');
  return { list: settings.raw.classes.map(({ id, name, color }) => ({ id, name, color })), active: settings.raw.activeClass, inUse: inUse ? { id: inUse.id, name: inUse.name, color: inUse.color } : null };
}

function classesChanged() {
  overlay?.webContents.send('ui:classes', classInfo());
  tutor.refresh();
}

function setActiveClass(id: ActiveClass) {
  if (id !== 'auto' && id !== 'none' && !settings.raw.classes.some((c) => c.id === id)) return settings.view();
  settings.update({ activeClass: id });
  classesChanged();
  setupWin?.webContents.send('settings:changed', settings.view());
  return settings.view();
}

// ---------------- tray and hotkey ----------------

function createTray() {
  const icon = nativeImage.createFromPath(ICON);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('myTA');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Call tanrushu', click: callHere },
      { label: 'Set the problem (photo or PDF)…', click: openProblem },
      { label: 'Setup…', click: openSetup },
      { type: 'separator' },
      { label: 'Quit myTA', click: () => app.quit() },
    ]),
  );
  tray.on('click', callHere);
}

// ---------------- start ----------------

async function selftest() {
  await new Promise((r) => setTimeout(r, 1500));
  const w = tracker.poll();
  const out: Record<string, unknown> = { foreground: foregroundWindow(), workWindow: w };
  if (w) {
    const shot = await realScreen.shot(w, 'read');
    if (shot) {
      const file = join(app.getPath('userData'), 'selftest.jpg');
      writeFileSync(file, Buffer.from(shot.jpeg, 'base64'));
      Object.assign(out, { file, size: `${shot.width}x${shot.height}`, rectDip: shot.rectDip });
    } else out.capture = 'failed';
  }
  process.stdout.write(`SELFTEST ${JSON.stringify(out)}\n`);
  app.exit(0);
}

/**
 * A real session with the saved keys, driven from here instead of by clicks: call → read the problem → (watch) → Hint → Video → Check my
 * work. It prints what the student would see and how long each step took (never the answer key). The overlay is on screen the whole time.
 */
async function liveTest() {
  const out = (line: string) => process.stdout.write(`LIVE ${line}\n`);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (ok: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !ok()) await wait(200);
    return ok();
  };
  const said = () => (lastState?.bubble ? `[${lastState.bubble.kind}] ${lastState.bubble.title}: ${lastState.bubble.text}` : '(no bubble)');
  const step = async (name: string, run: () => Promise<void>, done: () => boolean, ms = 90_000) => {
    const t0 = Date.now();
    await run();
    const ok = await until(done, ms);
    out(`${ok ? 'OK  ' : 'FAIL'} ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s) ${said()}`);
    return ok;
  };
  out(`keys: gemini ${settings.geminiKey() ? 'saved' : 'MISSING'}, serpapi ${settings.serpKey() ? 'saved' : 'MISSING'}; models ${settings.raw.model} / ${settings.raw.solverModel}`);
  const skip = /Claude|Visual Studio Code|Windows Terminal|cmd\.exe|PowerShell|myTA/i;
  out('Click on your notes window now (60 s)…');
  const found = await until(() => !!tracker.current() && !skip.test(tracker.current()!.title), 60_000);
  if (!found) {
    out('FAIL no notes window was clicked');
    return app.exit(1);
  }
  out(`work window: "${tracker.current()!.title}"`);
  const ready = () => lastState?.busy === null && !!lastState?.bubble && !lastState.bubble.pending;
  await step('Call sprite → problem read', () => tutor.act({ type: 'call' }), () => lastState?.phase === 'watching' || lastState?.phase === 'noProblem', 150_000);
  if (lastState?.phase !== 'watching') return app.exit(1);
  out(`problem: ${lastState.problem}`);
  await wait(4000);
  out(`after the first read: mark ${lastState.mark ? 'SHOWN' : 'none'}; ${said()}`);
  await step('Hint', () => tutor.act({ type: 'hint' }), () => ready() && lastState!.bubble!.kind === 'hint');
  await step('Another hint', () => tutor.act({ type: 'another' }), () => ready() && /Hint 2/.test(lastState!.bubble!.title));
  await step('Video', () => tutor.act({ type: 'video' }), () => ready() && lastState!.bubble!.kind === 'video', 30_000);
  if (lastState?.bubble?.video) out(`video: "${lastState.bubble.video.title}" (${lastState.bubble.video.channel}) at ${lastState.bubble.video.at} → ${lastState.bubble.video.url}`);
  await step('Check my work', () => tutor.act({ type: 'check' }), () => ready() && lastState!.busy === null && lastState!.bubble!.title !== 'Checking your work…', 90_000);
  out(`red square: ${lastState?.mark ? JSON.stringify(lastState.mark) : 'none'}`);
  out('done (leaving the overlay up for 20 s)');
  await wait(20_000);
  app.exit(0);
}

app.whenReady().then(async () => {
  settings = new SettingsStore(
    join(app.getPath('userData'), 'settings.json'),
    { available: () => safeStorage.isEncryptionAvailable(), encrypt: (s) => safeStorage.encryptString(s).toString('base64'), decrypt: (s) => safeStorage.decryptString(Buffer.from(s, 'base64')) },
    process.env,
  );
  limiter = new RateLimiter(settings.raw.rpm);
  // Learn the backup models now, so the very first read can already fall back on one.
  if (settings.geminiKey()) knownModels(settings.geminiKey());

  const e2eRect = { x: 120, y: 90, width: 900, height: 640 };
  const e2eWin: WinInfo = { hwnd: 7, pid: 4242, title: 'Homework notes - OneNote', cls: 'Framework::CFrame', rect: e2eRect, minimized: false, exe: 'onenote.exe' };
  // The test can put a different app in front by writing "title|program|id" next to the shot file.
  const e2eRead = (): WinInfo => {
    const f = `${process.env.MYTA_E2E_SHOT ?? ''}.window`;
    if (!existsSync(f)) return e2eWin;
    // "title|program|id|class|minimized": the last two are optional ("Progman" is the desktop).
    const [title, exe, id, cls, min] = readFileSync(f, 'utf8').trim().split('|');
    return { ...e2eWin, title, exe, hwnd: Number(id) || 8, cls: cls || e2eWin.cls, minimized: min === '1' };
  };
  screenSrc = E2E ? fileScreen(() => process.env.MYTA_E2E_SHOT ?? '', e2eRect) : realScreen;
  // MYTA_SAVE_SHOTS=1: keep the last picture tanrushu read in last-read.jpg next to the settings, to see what it saw.
  if (process.env.MYTA_SAVE_SHOTS === '1') {
    const base = screenSrc;
    screenSrc = {
      ...base,
      async shot(win, mode) {
        const s = await base.shot(win, mode);
        if (s && mode === 'read') writeFileSync(join(app.getPath('userData'), 'last-read.jpg'), Buffer.from(s.jpeg, 'base64'));
        return s;
      },
    };
  }
  tracker = new WorkWindowTracker(
    E2E ? e2eRead : foregroundWindow,
    () => new Set([process.pid]),
    (w) => {
      moveOverlayTo(w);
      updateVisibility();
      if (overlay) overlay.webContents.send('ui:classes', classInfo());
    },
    () => updateVisibility(),
  );
  tracker.start(400);
  if (SELFTEST) return selftest();

  // The camera is only ever used by myTA's own pages (taking a photo of the problem, or of a face for the sprite).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));

  const cacheKv = {
    get: async (key: string) => ({ [key]: settings.raw.videoCache[key] }),
    set: async (items: Record<string, unknown>) => settings.update({ videoCache: { ...settings.raw.videoCache, ...items } }),
  };
  const videos = new VideoFinder(new VideoCache(cacheKv), () => ({ serpKey: settings.serpKey(), ctx: llm() }));

  tutor = new TutorService({
    llm,
    hasSerpKey: () => !!settings.serpKey(),
    course: () => toCourse(resolveClass(settings.raw.classes, settings.raw.activeClass, tracker.current()?.title ?? '')),
    workWindow: () => tracker.current(),
    // Only read the work while tanrushu is on screen for it: the notes app is the window in front.
    canWatch: (w) => shouldShow() && tracker.inFront()?.hwnd === w.hwnd,
    screen: screenSrc,
    idleSec: () => (E2E ? Number(process.env.MYTA_E2E_IDLE ?? 3) : powerMonitor.getSystemIdleTime()),
    overlayOrigin: () => {
      // The red square is drawn on the marks layer, which covers the display.
      const b = marks?.getBounds();
      return b ? { x: b.x, y: b.y } : { x: 0, y: 0 };
    },
    emit,
    openUrl: (url) => {
      e2eLog(`open ${url}`);
      if (!E2E && /^https:\/\/(www\.)?youtube\.com\//.test(url)) void shell.openExternal(url);
    },
    openSetup,
    openProblem,
    solvedToday: () => settings.solvedToday(),
    addSolved: () => settings.addSolved(),
    videos,
    tickMs: E2E ? 300 : undefined,
    log: (m) => e2eLog(`log ${m}`),
  });

  wireIpc();
  createOverlay();
  createTray();
  if (LIVETEST) return void liveTest();
  if (!globalShortcut.register(HOTKEY, callHere)) e2eLog('hotkey unavailable');
  if (E2E) (globalThis as Record<string, unknown>).__myta = { tutor, settings };
  // First run: no key yet, so open setup.
  if ((!settings.geminiKey() || process.argv.includes('--setup')) && !E2E) openSetup();
});

// Starting myTA again while it runs: "--setup" opens Setup, anything else calls tanrushu.
app.on('second-instance', (_e, argv) => {
  if (argv.includes('--setup')) openSetup();
  else if (tutor) callHere();
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  urlReader.stop();
});
// The overlay is a window too, but closing setup must not quit: myTA lives in the tray until Quit.
app.on('window-all-closed', () => undefined);
