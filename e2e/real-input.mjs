// Real input, on the real screen: moves the actual mouse onto tanrushu and clicks, double-clicks and taps it, the way a person would.
// The other tests send clicks straight to the page, which skips the part that decides whether a click lands on tanrushu or goes through
// to the app underneath; this one doesn't. Model calls are scripted (no keys needed). Uses the mouse for about 25 seconds.
import { _electron as electron } from 'playwright';
import koffi from 'koffi';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(root, 'e2e/artifacts/fixtures');
const run = join(root, 'e2e/artifacts/real');
rmSync(run, { recursive: true, force: true });
mkdirSync(run, { recursive: true });
const shot = join(run, 'screen.png');
copyFileSync(join(fixtures, 'start.png'), shot);
writeFileSync(`${shot}.name`, 'start');
const logFile = join(run, 'log.jsonl');
const script = join(run, 'script.json');
writeFileSync(
  script,
  JSON.stringify({
    solve: { problemDetected: true, problemText: 'Find dy/dx for y = sin(3x^2)', domain: 'calculus', problemKind: 'chain rule', difficulty: 2, keySteps: ['a'], checkpoints: [], finalAnswer: '6x cos(3x^2)', keyConfidence: 'high', conceptTags: ['chain rule'], misconceptions: [], answerKeyPhrases: [], videoConcept: 'chain rule', videoQuery: 'chain rule explained' },
    reviews: {
      wrong: { differentProblem: false, readability: 'clear', workRead: 'y = sin(3x²) / dy/dx = cos(3x²)', copyState: 'complete', copiedWrong: false, observation: 'drops the inside derivative', status: 'mistake', wrongPart: 'cos(3x²)', box: [270, 40, 370, 340], studentMessage: 'Look at your last line.' },
    },
    delays: { solve: 300 },
  }),
);

const user32 = koffi.load('user32.dll');
const SetCursorPos = user32.func('int __stdcall SetCursorPos(int x, int y)');
const mouse_event = user32.func('void __stdcall mouse_event(uint32_t flags, uint32_t dx, uint32_t dy, uint32_t data, uintptr_t extra)');
const GetDpiForSystem = user32.func('uint32_t __stdcall GetDpiForSystem()');
const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' });
const WindowFromPoint = user32.func('void* __stdcall WindowFromPoint(POINT p)');
const GetAncestor = user32.func('void* __stdcall GetAncestor(void* h, uint32_t flags)');
const SetProcessDPIAware = user32.func('int __stdcall SetProcessDPIAware()');
SetProcessDPIAware();
const scale = Number(GetDpiForSystem()) / 96;
const LEFTDOWN = 2;
const LEFTUP = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Moves the real pointer to a point given in DIPs, in small steps (so the page sees the pointer arrive, as with a real hand). */
async function moveTo(x, y) {
  for (let i = 1; i <= 6; i++) {
    SetCursorPos(Math.round(x * scale) - (6 - i) * 4, Math.round(y * scale) - (6 - i) * 4);
    await sleep(25);
  }
}
async function click() {
  mouse_event(LEFTDOWN, 0, 0, 0, 0);
  await sleep(60);
  mouse_event(LEFTUP, 0, 0, 0, 0);
}

const app = await electron.launch({
  executablePath: join(root, 'node_modules/electron/dist/electron.exe'),
  args: [root],
  env: { ...process.env, MYTA_E2E: '1', MYTA_E2E_SCRIPT: script, MYTA_E2E_LOG: logFile, MYTA_E2E_SHOT: shot, MYTA_USER_DATA: join(run, 'userdata'), MYTA_GEMINI_KEY: 'k', MYTA_SERP_KEY: 'k' },
});
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failures++;
};
const log = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await sleep(150);
  }
  return false;
};

try {
  let page = null;
  await until(async () => (page = app.windows().find((w) => w.url().includes('/overlay/')) ?? null), 15000);
  await page.waitForSelector('.char');
  await sleep(800);
  // Where something on tanrushu's dock is on the screen, in DIPs.
  const whereNow = async (sel) => {
    const r = await page.locator(sel).first().boundingBox();
    const b = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'myTA')?.getContentBounds());
    return { x: b.x + r.x + r.width / 2, y: b.y + r.y + r.height / 2 };
  };
  // Once the bubble has finished appearing or changing (a hand also waits to see where to tap).
  const where = async (sel) => {
    let a = await whereNow(sel);
    for (let i = 0; i < 15; i++) {
      await sleep(120);
      const b = await whereNow(sel);
      if (Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1) return b;
      a = b;
    }
    return a;
  };
  const phase = () => page.locator('.status-line').textContent().catch(() => '');
  const title = () => page.locator('.card .title').first().textContent().catch(() => '');
  // Each read is a quick solve, then a careful one: count the quick ones.
  const reads = () => { const s = log().filter((e) => e.api === 'gemini' && e.kind === 'solve'); return s.filter((e) => e.model === s[0]?.model).length; };
  const hwndOf = (t) => app.evaluate(({ BrowserWindow }, t) => { const b = BrowserWindow.getAllWindows().find((w) => w.getTitle() === t)?.getNativeWindowHandle(); return b ? String(b.readBigUInt64LE(0)) : ''; }, t);
  const atPoint = (x, y) => String(koffi.address(GetAncestor(WindowFromPoint({ x: Math.round(x * scale), y: Math.round(y * scale) }), 2)));

  // 0. It reads the problem by itself; nothing to press first.
  check(await until(async () => /Watching/.test(await phase()), 10000), 'it reads the problem by itself and starts watching');
  check(reads() === 1, '…reading it once');

  // 1. One real click on the monkey: it says hi.
  let p = await where('.char');
  check(atPoint(p.x, p.y) === (await hwndOf('myTA')), 'the pointer over tanrushu is over its own window (so clicks reach it)');
  await moveTo(p.x, p.y);
  await click();
  check(await until(async () => (await title()) === "I'm here!"), 'one real click on tanrushu says hi');
  await page.screenshot({ path: join(run, '1-after-click.png') });

  // 2. A nap, then a real double-click: it wakes once, and doesn't read twice.
  await app.evaluate(() => globalThis.__myta.tutor.sleep());
  await sleep(600);
  p = await where('.char');
  await moveTo(p.x, p.y);
  await click();
  await sleep(90);
  await click();
  check(await until(async () => reads() === 2), 'a real double-click wakes it up');
  await sleep(1500);
  check(reads() === 2, '…and it reads once, not twice');
  check(await until(async () => /Watching/.test(await phase())), '…then watches again');
  // The status changed from "Napping · tap me" to "Watching …": tanrushu itself must not have moved, or a tap aimed at it misses.
  await page.locator('.card .x').click().catch(() => undefined);
  const after = await where('.char');
  check(Math.abs(after.x - p.x) <= 2 && Math.abs(after.y - p.y) <= 2, `tanrushu stays put when its status changes (${Math.round(p.x)},${Math.round(p.y)} → ${Math.round(after.x)},${Math.round(after.y)})`);

  // 3. A quick tap, the way a touchpad taps (down and up with no movement in between).
  await app.evaluate(() => globalThis.__myta.tutor.sleep());
  await sleep(600);
  p = await where('.char');
  SetCursorPos(Math.round(p.x * scale), Math.round(p.y * scale));
  mouse_event(LEFTDOWN, 0, 0, 0, 0);
  mouse_event(LEFTUP, 0, 0, 0, 0);
  check(await until(async () => reads() === 3), 'a quick touchpad-style tap wakes it');
  await until(async () => /Watching/.test(await phase()));

  // 4. The Hint button, for real, and then a button inside the speech bubble.
  p = await where('.tools .tool');
  await moveTo(p.x, p.y);
  await click();
  check(await until(async () => (await title()) === 'Hint 1'), 'a real click on Hint gives a hint');
  p = await where('.card .row button:has-text("Another hint")');
  await moveTo(p.x, p.y);
  await click();
  check(await until(async () => log().filter((e) => e.api === 'gemini' && e.kind === 'hint').length === 2), 'a real click on a button in the bubble works (Another hint)');
  await page.screenshot({ path: join(run, '4-hint.png') });

  // 4b. Every other control answers a real click: the bubble's ×, Video, the ⋯ menu and an item in it.
  await until(async () => (await title()) === 'Hint 2');
  const bubbles = () => page.locator('.card').count();
  p = await where('.card .x');
  await moveTo(p.x, p.y);
  await click();
  check(await until(async () => (await bubbles()) === 0), 'a real click on the bubble’s × closes it');
  p = await where('.tools .tool:has-text("Video")');
  await moveTo(p.x, p.y);
  await click();
  check(await until(async () => (await bubbles()) > 0), 'a real click on Video answers');
  p = await where('.card .x');
  await moveTo(p.x, p.y);
  await click();
  await until(async () => (await bubbles()) === 0);
  p = await where('.tools .tool.more');
  await moveTo(p.x, p.y);
  await click();
  check(await until(() => page.locator('.menu').isVisible()), 'a real click on ⋯ opens the menu');
  p = await where('.menu [role=menuitem]:has-text("Take a nap")');
  await moveTo(p.x, p.y);
  await click();
  check(await until(async () => /Napping/.test(await phase())), 'a real click on a menu item works (Take a nap)');
  p = await where('.char');
  await moveTo(p.x, p.y);
  await click();
  await until(async () => /Watching/.test(await phase()));

  // 5. Drag it somewhere else: it moves, and it is not taken as a tap.
  const r0 = reads();
  const from = await where('.char');
  await moveTo(from.x, from.y);
  mouse_event(LEFTDOWN, 0, 0, 0, 0);
  for (let i = 1; i <= 10; i++) {
    SetCursorPos(Math.round((from.x - i * 12) * scale), Math.round((from.y - i * 6) * scale));
    await sleep(30);
  }
  mouse_event(LEFTUP, 0, 0, 0, 0);
  await sleep(500);
  const to = await where('.char');
  check(Math.abs(to.x - (from.x - 120)) <= 8 && Math.abs(to.y - (from.y - 60)) <= 8, `dragging moves tanrushu (${Math.round(from.x)},${Math.round(from.y)} → ${Math.round(to.x)},${Math.round(to.y)})`);
  check(reads() === r0, '…and a drag is not a tap');

  // 6. Everywhere else, clicks go through to the app underneath (the full-screen marks layer never catches them).
  const b = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
  const mine = [await hwndOf('myTA'), await hwndOf('myTA marks')];
  const spots = [[b.x + 200, b.y + 200], [b.x + b.width / 2, b.y + b.height / 2], [b.x + 40, b.y + b.height - 40]];
  check(spots.every(([x, y]) => !mine.includes(atPoint(x, y))), 'clicks anywhere else go through to the app underneath');

  // 6b. A mistake: the red square. A real click on its label closes it; a click inside the square goes through to the work.
  copyFileSync(join(fixtures, 'wrong.png'), shot);
  writeFileSync(`${shot}.name`, 'wrong');
  let marksPage = null;
  await until(async () => (marksPage = app.windows().find((w) => w.url().includes('/marks/')) ?? null), 5000);
  check(await until(() => marksPage.locator('.mark .tag').isVisible(), 15000), 'a mistake puts up the red square');
  await sleep(800);
  const onMarks = async (sel) => {
    const r = await marksPage.locator(sel).first().boundingBox();
    const b = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'myTA marks')?.getContentBounds());
    return { x: b.x + r.x + r.width / 2, y: b.y + r.y + r.height / 2 };
  };
  const marksHwnd = await hwndOf('myTA marks');
  const tagAt = await onMarks('.mark .tag');
  const inside = await onMarks('.mark');
  check(atPoint(inside.x, inside.y) !== marksHwnd, 'a click inside the square goes through to the work underneath');
  check(atPoint(tagAt.x, tagAt.y) === marksHwnd, 'the label on the square takes the click');
  await moveTo(tagAt.x, tagAt.y);
  await click();
  check(await until(async () => (await marksPage.locator('.mark').count()) === 0, 5000), 'a real click on the square’s label closes it');
  check(atPoint(inside.x, inside.y) !== marksHwnd, '…and nothing is left catching clicks there');

  // 7. tanrushu is left out of screen captures (so it never reads its own bubble or square as the student's work), also after it was
  // hidden for an app that isn't for notes and shown again. The capture with it on screen must match the capture with it invisible.
  const shownNow = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'myTA')?.isVisible() ?? false);
  writeFileSync(`${shot}.window`, 'Spotify Premium|spotify.exe|99');
  await until(async () => !(await shownNow()));
  rmSync(`${shot}.window`);
  await until(() => shownNow());
  await sleep(1000);
  const diff = await app.evaluate(async ({ BrowserWindow, desktopCapturer, screen }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'myTA');
    const b = w.getBounds();
    const d = screen.getDisplayMatching(b);
    const sf = d.scaleFactor;
    const grab = async () => {
      const list = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(d.size.width * sf), height: Math.round(d.size.height * sf) } });
      const src = list.find((x) => x.display_id === String(d.id)) ?? list[0];
      const k = src.thumbnail.getSize().width / d.size.width;
      return src.thumbnail.crop({ x: Math.round((b.x - d.bounds.x) * k), y: Math.round((b.y - d.bounds.y) * k), width: Math.round(b.width * k), height: Math.round(b.height * k) }).toBitmap();
    };
    const on = await grab();
    w.setOpacity(0);
    await new Promise((r) => setTimeout(r, 400));
    const off = await grab();
    w.setOpacity(1);
    let sum = 0;
    for (let i = 0; i < Math.min(on.length, off.length); i++) sum += Math.abs(on[i] - off[i]);
    return sum / Math.max(1, Math.min(on.length, off.length));
  });
  check(diff < 2, `tanrushu is left out of screen captures, even after being hidden and shown again (difference ${diff.toFixed(2)})`);
} catch (e) {
  console.log(`FAIL  crashed: ${e instanceof Error ? e.stack : e}`);
  failures++;
} finally {
  await app.close().catch(() => undefined);
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll real-input checks passed');
process.exit(failures ? 1 : 0);
