// End to end: launches the real built app (Electron, the real overlay, setup and problem windows, the real tutor service) with a
// simulated work window and scripted Gemini/SerpApi answers, then goes through a whole session the way a student would:
//   it reads the problem by itself → a tap says hi → a wrong line → red square + message → Hint, Another hint → Video at the right minute →
//   the right answer → confetti and the count → course topics in setup → a new problem uses them → upload a photo of the problem and
//   say which one → a custom sprite → sleep.
// Screenshots of each step go to e2e/artifacts/. Exits non-zero on the first failed check.
import { _electron as electron } from 'playwright';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const art = join(root, 'e2e/artifacts');
const fixtures = join(art, 'fixtures');
const run = join(art, 'run');
rmSync(run, { recursive: true, force: true });
mkdirSync(run, { recursive: true });
const electronBin = join(root, 'node_modules/electron/dist/electron.exe');
if (!existsSync(join(fixtures, 'wrong.png'))) execFileSync(electronBin, [join(root, 'e2e/makeFixtures.cjs'), fixtures], { stdio: 'inherit' });

const shot = join(run, 'screen.png');
const logFile = join(run, 'log.jsonl');
const show = (name) => {
  copyFileSync(join(fixtures, `${name}.png`), shot);
  writeFileSync(`${shot}.name`, name);
};
show('start');

const KEY = {
  problemDetected: true,
  problemText: 'Problem 2a. Find dy/dx for y = sin(3x^2)',
  givens: '',
  domain: 'calculus',
  problemKind: 'chain rule',
  workFormat: 'equations',
  difficulty: 2,
  expectedMinutes: 3,
  keySteps: ['outer function sin(u) with u = 3x^2', 'derivative cos(u) times du/dx', 'du/dx = 6x'],
  checkpoints: [{ label: 'inner derivative', expected: '6x' }],
  finalAnswer: '6x cos(3x^2)',
  verification: 'differentiated term by term',
  keyConfidence: 'high',
  conceptTags: ['chain rule'],
  misconceptions: ['forgetting to multiply by the derivative of the inside'],
  answerKeyPhrases: ['6x cos(3x^2)'],
  videoConcept: 'chain rule',
  videoQuery: 'chain rule explained',
};
const SCRIPT = {
  solve: KEY,
  reviews: {
    start: { differentProblem: false, readability: 'clear', workRead: 'y = sin(3x²)', copyState: 'complete', copiedWrong: false, observation: '', status: 'on_track', box: [], studentMessage: '' },
    wrong: {
      differentProblem: false, readability: 'clear', workRead: 'y = sin(3x²) / dy/dx = cos(3x²)', copyState: 'complete', copiedWrong: false,
      observation: 'Second line drops the derivative of the inside function.', status: 'mistake', wrongPart: 'cos(3x²)', box: [270, 40, 370, 340],
      studentMessage: "Look at your second line. You took the derivative of the outside, but what happens to the 3x² inside it?",
    },
    right: { differentProblem: false, readability: 'clear', workRead: 'dy/dx = 6x cos(3x²)', copyState: 'complete', copiedWrong: false, observation: '', status: 'solved', box: [], studentMessage: 'Yes! You remembered to multiply by the inside’s derivative.' },
    upload: { differentProblem: false, readability: 'nothing_written', workRead: '', copyState: 'not_copied', copiedWrong: false, observation: '', status: 'no_work', box: [], studentMessage: '' },
  },
  hint: [
    { replyAssessment: 'none', hintLevel: 1, message: 'What two functions are stacked inside each other in sin(3x²)?', missingPrerequisite: '' },
    { replyAssessment: 'none', hintLevel: 2, message: 'This is a job for the chain rule: what do you multiply the outer derivative by?', missingPrerequisite: 'composite functions' },
  ],
  judge: { leaks: false, reason: '' },
  // The close look at the wrong line finds just the wrong part: [290, 60, 350, 240] of the window.
  locate: { seen: 'cos(3x²)', found: true, box: [400, 100, 600, 400] },
  syllabus: { course: 'Calculus I', coveredUpTo: 'through week 6', topics: ['Limits', 'power rule', 'product rule', 'chain rule'] },
  serp: {
    video_results: [
      { title: 'Chain rule explained', link: 'https://www.youtube.com/watch?v=abcdefghijk', channel: { name: 'Khan Academy' }, length: '8:20', description: 'The chain rule', chapters: [{ title: 'Intro', time_start: 0 }, { title: 'The chain rule', time_start: 75 }, { title: 'Examples', time_start: 300 }] },
    ],
  },
  delays: { solve: 400, review: 250, hint: 200 },
};
const scriptFile = join(run, 'script.json');
writeFileSync(scriptFile, JSON.stringify(SCRIPT));

const app = await electron.launch({
  executablePath: electronBin,
  args: [root],
  env: {
    ...process.env,
    MYTA_E2E: '1',
    MYTA_E2E_SCRIPT: scriptFile,
    MYTA_E2E_LOG: logFile,
    MYTA_E2E_SHOT: shot,
    MYTA_E2E_UPLOAD: join(fixtures, 'upload.png'),
    MYTA_USER_DATA: join(run, 'userdata'),
    MYTA_GEMINI_KEY: 'e2e-gemini-key',
    MYTA_SERP_KEY: 'e2e-serp-key',
  },
});

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failures++;
};
const log = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const geminiCalls = (kind) => log().filter((e) => e.api === 'gemini' && e.kind === kind);
// Each read is a quick solve (shown right away), then a careful one that replaces it: count the quick ones.
const reads = () => { const s = geminiCalls('solve'); const quick = s[0]?.model; return s.filter((e) => e.model === quick); };
const until = async (fn, ms = 15_000, step = 150) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
};
const pageWith = async (part) => {
  let found = null;
  await until(async () => (found = app.windows().find((w) => w.url().includes(part)) ?? null), 15_000);
  return found;
};
// Everything tanrushu shows (the bubble with its ×, the menu, the tools) must sit inside its window: a part that spills out can be seen
// but not clicked (the click goes to the app underneath).
const fits = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.card, .menu, .stack')].every((el) => {
      const r = el.getBoundingClientRect();
      return r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
    }),
  );
const snap = async (page, name) => {
  if (page.url().includes('/overlay/')) check(await until(() => fits(page), 3000), `${name}: all of tanrushu's bubble, menu and tools are inside its window (every part takes clicks)`);
  await page.screenshot({ path: join(run, `${name}.png`) }).catch(() => undefined);
};

try {
  const overlay = await pageWith('/overlay/');
  check(!!overlay, 'the overlay window opens');
  await overlay.waitForSelector('.char', { timeout: 15_000 });
  const marks = await pageWith('/marks/');
  check(!!marks, 'the click-through marks layer opens');
  check(await overlay.locator('.avatar.is-monkey').isVisible(), 'the default sprite is the pixel monkey');
  check((await overlay.locator('.tools .tool:not(.more)').count()) === 2, 'the toolbar is just Hint and Video (reading and checking are automatic)');
  for (const t of ['Hint', 'Video']) check(await overlay.locator('.tools .tool', { hasText: t }).isVisible(), `"${t}" is on screen from the start (no Call button needed)`);
  await snap(overlay, '01-start');

  // 0. Only in note-taking apps: switch to Spotify and tanrushu hides; back to OneNote and it's there again.
  const overlayShown = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'myTA')?.isVisible() ?? false);
  const marksShown = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'myTA marks')?.isVisible() ?? false);
  const dockFocusable = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'myTA')?.isFocusable() ?? true);
  check(!(await dockFocusable()), 'tanrushu never takes the focus away from the notes app');
  check(await overlayShown(), 'tanrushu shows in a notes app (OneNote)');
  writeFileSync(`${shot}.window`, 'Spotify Premium|spotify.exe|99');
  check(await until(async () => !(await overlayShown()) && !(await marksShown()), 5000), '…and hides (with its marks layer) when you switch to an app that is not for notes (Spotify)');
  rmSync(`${shot}.window`);
  check(await until(() => overlayShown(), 5000), '…and comes back when you switch back');
  writeFileSync(`${shot}.window`, '|explorer.exe|50|Progman');
  check(await until(async () => !(await overlayShown()), 5000), '…and hides on the desktop');
  writeFileSync(`${shot}.window`, 'Homework notes - OneNote|onenote.exe|7|Framework::CFrame|1');
  check(await until(async () => !(await overlayShown()), 5000), '…and when the notes app is minimized');
  rmSync(`${shot}.window`);
  check(await until(() => overlayShown(), 5000), '…and is back as soon as the notes app is in front again');

  // 1. It reads the problem by itself, quietly, and watches the work.
  check(await until(() => overlay.locator('.status-line').textContent().then((t) => /Watching OneNote/.test(t ?? ''))), 'it reads the problem by itself and watches the notes app');
  check(reads().length === 1, 'the problem was read once (no read twice for the same window)');
  check(await until(() => geminiCalls('solve').length === 2, 8000), '…and a careful answer key replaces the quick one in the background');
  await overlay.locator('.char').click();
  check(await until(() => overlay.locator('.card .title', { hasText: "I'm here!" }).isVisible()), 'a tap on tanrushu says hi');
  check((await overlay.locator('.card button', { hasText: 'Hint' }).count()) >= 1, '…and offers Hint, Video and Check');
  const chainSearches = () => log().filter((e) => e.api === 'serpapi' && /search_query=chain(?:\+|%20)rule(?:\+|%20)explained/.test(e.url));
  check(chainSearches().length === 1, 'the video search started in the background right away');
  check((await overlay.content()).includes('6x cos') === false, 'the answer never reaches the overlay');
  await snap(overlay, '02-watching');

  // 2. A wrong line: red square, then where to look.
  show('wrong');
  const markShown = await until(() => marks.locator('.mark').isVisible(), 12_000);
  check(markShown, 'a red square appears on the wrong line after it is written');
  // Where the square is placed (its own left/top, not the pop-in animation's scaled outline).
  const box = await marks.locator('.mark').evaluate((el) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) }));
  // The work window is at (120, 90) and 900x640. The reviewer pointed at the line [270, 40, 370, 340]; the close look found the wrong part
  // itself at [290, 60, 350, 240] of the window. Plus 4 px of room on each side.
  check(Math.abs(box.x - (120 + 54 - 4)) <= 1 && Math.abs(box.y - (90 + 185.6 - 4)) <= 1 && Math.abs(box.w - (162 + 8)) <= 1 && Math.abs(box.h - (38.4 + 8)) <= 1, `…exactly over the wrong part, not the whole line (${JSON.stringify(box)})`);
  const look = geminiCalls('locate')[0];
  check(!!look && look.files.includes('image/jpeg') && look.text.includes('cos(3x²)'), 'the square was placed with a close look at the wrong part');
  check(await until(() => overlay.locator('.card .msg').textContent().then((t) => /second line/.test(t ?? ''))), 'the message says where to look');
  check(!(await overlay.locator('.card .msg').textContent())?.includes('6x'), '…without giving the answer');
  check(geminiCalls('judge').length >= 1, 'the message went through the leak check first');
  await snap(overlay, '03-mistake');
  check((await overlay.locator('.card .quote code').textContent()) === 'cos(3x²)', 'the bubble quotes the exact piece of work that is wrong');
  // Another notes window in front: the square is not left floating over it; back to the work, it returns.
  writeFileSync(`${shot}.window`, 'Other notes - OneNote|onenote.exe|12');
  check(await until(async () => (await marks.locator('.mark').count()) === 0, 5000), 'the square goes away when another window is in front');
  rmSync(`${shot}.window`);
  check(await until(() => marks.locator('.mark').isVisible(), 5000), '…and comes back over the work when it is in front again');
  await snap(marks, '03b-mark');

  // 3. Hint, then another hint.
  await overlay.locator('.tools .tool', { hasText: 'Hint' }).click();
  check(await until(() => overlay.locator('.card .title', { hasText: 'Hint 1' }).isVisible()), 'Hint gives a hint');
  check((await overlay.locator('.card .msg').textContent())?.includes('stacked'), '…pointing in the right direction');
  await overlay.getByRole('button', { name: 'Another hint' }).click();
  check(await until(() => overlay.locator('.card .title', { hasText: 'Hint 2' }).isVisible()), 'Another hint goes a level deeper');
  check(await overlay.getByRole('button', { name: 'Video: composite functions' }).isVisible(), 'a missing basic gets its own video button');
  const hints = geminiCalls('hint');
  check(hints.length === 2 && hints[1].text.includes('What two functions are stacked'), 'the second hint knew the first, so it does not repeat it');
  await snap(overlay, '04-hint');

  // 4. Video: shown right away, at the minute that explains it.
  const t0 = Date.now();
  await overlay.locator('.tools .tool', { hasText: 'Video' }).click();
  check(await until(() => overlay.locator('.clip').isVisible(), 5000), 'Video shows a clip');
  check(Date.now() - t0 < 2500, `…fast (${Date.now() - t0} ms), because it was found in the background`);
  check(await overlay.getByRole('button', { name: 'Watch it (1:15)' }).isVisible(), '…starting at the chapter that explains the concept (1:15)');
  await overlay.getByRole('button', { name: 'Watch it (1:15)' }).click();
  check(await until(() => log().some((e) => e.event === 'open https://www.youtube.com/watch?v=abcdefghijk&t=75s')), 'Watch opens YouTube at that minute');
  check(chainSearches().length === 1, 'no new search was needed: the clip came from the background search');
  check(log().some((e) => e.api === 'serpapi' && /composite(?:\+|%20)functions/.test(e.url)), 'the video for the missing basic was looked up in the background too');
  await snap(overlay, '05-video');

  // 4b. The square's own label closes it.
  check(await until(() => marks.locator('.mark .tag').isVisible(), 5000), 'the square has a close label');
  await marks.locator('.mark .tag').click();
  check(await until(async () => (await marks.locator('.mark').count()) === 0, 5000), 'clicking the label on the square closes it');

  // 5. The right answer: cheer.
  show('right');
  check(await until(() => overlay.locator('.card .title', { hasText: 'You got it!' }).isVisible(), 12_000), 'it cheers when the problem is solved');
  check(await until(() => overlay.locator('.card .msg').textContent().then((t) => /1 solved today/.test(t ?? ''))), '…and counts it');
  check(!(await marks.locator('.mark').count()), 'the red square is gone');
  check(await overlay.locator('.status-line .solved').isVisible(), 'the banana counter shows on the status line');
  await snap(overlay, '06-solved');

  // 6. Classes in setup: add one, type topics, drop in a syllabus, and tanrushu follows it.
  await overlay.locator('.tool.more').click();
  await overlay.getByRole('menuitem', { name: /Setup/ }).click();
  const setup = await pageWith('/settings/');
  check(!!setup, 'setup opens');
  await setup.waitForSelector('.rail');
  check((await setup.content()).includes('Saved · …-key'), 'setup shows the keys are saved (only the last four characters)');
  check(!(await setup.content()).includes('e2e-gemini-key'), 'the key itself never reaches setup');
  await snap(setup, '07a-setup-top');
  await setup.getByRole('button', { name: 'Add a class' }).click();
  await setup.getByLabel('New class name').fill('Calc I');
  await setup.getByRole('button', { name: 'Add', exact: true }).click();
  check(await until(() => setup.locator('.spine', { hasText: 'Calc I' }).isVisible()), 'a new class goes on the shelf');
  const topicInput = setup.getByLabel('Add a topic');
  for (const t of ['limits', 'power rule']) {
    await topicInput.fill(t);
    await topicInput.press('Enter');
  }
  check(await until(() => setup.locator('.chip.topic', { hasText: 'power rule' }).isVisible()), 'topics are added as you type them');
  await setup.locator('.dropzone input[type=file]').setInputFiles(join(fixtures, 'upload.png'));
  check(await until(() => setup.locator('.chip.topic.fresh', { hasText: 'chain rule' }).isVisible(), 8000), 'dropping in a syllabus adds the topics it finds (new ones light up)');
  check(await until(() => setup.locator('.buddy-bubble').textContent().then((t) => /Found 2 new topics/.test(t ?? ''))), 'tanrushu in the sidebar says what it found');
  check((await setup.locator('.chip.topic').count()) === 4, 'no topic is listed twice');
  check(await until(() => setup.locator('.spine.open .spine-count').textContent().then((t) => t === '4'), 4000), 'the saved class has all 4 topics (typing then dropping a syllabus loses nothing)');
  await setup.locator('.open-book').scrollIntoViewIfNeeded();
  await snap(setup, '07b-class-book');
  await setup.locator('#options').scrollIntoViewIfNeeded();
  await new Promise((r) => setTimeout(r, 400));
  await snap(setup, '07c-options');
  await setup.locator('#classes').scrollIntoViewIfNeeded();
  check(log().filter((e) => e.api === 'gemini' && e.kind === 'syllabus').at(-1)?.files.includes('image/png'), 'the syllabus file itself was read');
  await new Promise((r) => setTimeout(r, 700));
  await setup.getByRole('radio', { name: 'Calc I' }).click();
  check(await until(() => overlay.locator('.status-line .class-tag', { hasText: 'Calc I' }).isVisible()), 'picking the class shows it next to tanrushu');
  await snap(setup, '07-setup');
  // Auto: a notes window titled with one of the class's words picks it by itself.
  await setup.getByLabel('Add a word').fill('Homework');
  await setup.getByLabel('Add a word').press('Enter');
  await new Promise((r) => setTimeout(r, 700));
  await setup.getByRole('radio', { name: 'Auto' }).click();
  check(await until(() => overlay.locator('.status-line .class-tag', { hasText: 'Calc I' }).isVisible()), 'Auto picks the class from the notes window title (Homework notes - OneNote)');
  await setup.getByRole('radio', { name: 'No class' }).click();
  check(await until(async () => (await overlay.locator('.status-line .class-tag').count()) === 0), 'No class turns the limits off');
  await overlay.locator('.tool.more').click();
  await overlay.getByRole('menuitemradio', { name: 'Calc I' }).click();
  check(await until(() => setup.locator('.segmented button.on', { hasText: 'Calc I' }).isVisible()), 'switching from the overlay menu updates setup too');
  await overlay.locator('.status-line .reread').click();
  check(await until(() => reads().length === 2), '"Wrong problem?" reads the screen again');
  check(reads()[1].text.includes('Course topics covered so far') && reads()[1].text.includes('chain rule'), '…and the answer key only uses what the class has covered');
  await overlay.locator('.tools .tool', { hasText: 'Hint' }).click();
  await until(() => geminiCalls('hint').length === 3);
  check(geminiCalls('hint')[2].text.includes('Never suggest a method the course has not reached yet'), 'hints follow the course topics too');

  // 7. Upload a photo of the problem and say which one.
  await overlay.locator('.tool.more').click();
  await overlay.getByRole('menuitem', { name: /Upload or snap/ }).click();
  const prob = await pageWith('/camera/');
  check(!!prob, 'the "set the problem" window opens');
  await prob.getByRole('button', { name: 'Upload a photo or PDF' }).click();
  check(await until(() => prob.locator('.problem-preview').isVisible()), 'the uploaded photo is previewed');
  await prob.getByLabel(/Which problem/).fill('2a');
  await snap(prob, '08-problem');
  await prob.getByRole('button', { name: 'Use this problem' }).click();
  check(await until(() => reads().length === 3), 'it works out the uploaded problem');
  const s3 = reads()[2];
  check(s3.files.includes('image/png') && s3.text.includes('"2a"'), '…from the photo, the one the student named');
  check(await until(() => overlay.locator('.status-line').textContent().then((t) => /Watching/.test(t ?? ''))), 'and goes back to watching the work');

  // 8. A custom sprite (the TA's picture) replaces the monkey everywhere at once.
  const png = 'data:image/png;base64,' + readFileSync(join(fixtures, 'start.png')).toString('base64');
  await setup.evaluate((p) => window.myta.settings.saveSprite({ mode: 'custom', png: p, style: 'sticker', name: 'Hao', updatedAt: 0 }), png);
  check(await until(() => overlay.locator('.avatar.is-custom').isVisible()), 'a custom sprite shows on screen right away');
  await setup.evaluate(() => window.myta.settings.saveSprite({ mode: 'monkey', updatedAt: 0 }));
  check(await until(() => overlay.locator('.avatar.is-monkey').isVisible()), 'and can go back to the monkey');

  // 9. Only notes on the page: no question, and it says so when asked for help.
  const script = JSON.parse(readFileSync(scriptFile, 'utf8'));
  writeFileSync(scriptFile, JSON.stringify({ ...script, solve: { ...KEY, problemDetected: false, problemText: '', pageKind: 'notes', candidates: [], ambiguous: false } }));
  await overlay.locator('.status-line .reread').click();
  check(await until(() => overlay.locator('.status-line').textContent().then((t) => /No problem on screen/.test(t ?? ''))), 'a page of notes is not taken for a problem');
  await overlay.locator('.tools .tool', { hasText: 'Hint' }).click();
  check(await until(() => overlay.locator('.card .title', { hasText: "I don't see a question on this page" }).isVisible()), 'Hint on a page of notes says there is no question on the page');
  await snap(overlay, '09-no-question');

  // 10. Two problems and nothing shows which: it asks, with a button for each.
  const two = [{ label: 'Question 1', summary: 'Find the limit', studentWorking: false }, { label: 'Question 2', summary: 'Find dy/dx', studentWorking: false }];
  writeFileSync(scriptFile, JSON.stringify({ ...script, solve: { ...KEY, candidates: two, ambiguous: true } }));
  await overlay.locator('.status-line .reread').click();
  check(await until(() => overlay.locator('.card .title', { hasText: 'Which question are we on?' }).isVisible()), 'with two problems it asks which one');
  check(await overlay.locator('.card button', { hasText: 'Question 2' }).isVisible(), '…with a button for each');
  check((await overlay.locator('.card .msg').textContent())?.includes('Question 2: Find dy/dx'), '…and says what each one asks');
  await snap(overlay, '10-which');
  const before = reads().length;
  await overlay.locator('.card button', { hasText: 'Question 2' }).click();
  check(await until(() => reads().length > before && reads().at(-1).text.includes('Question 2')), 'picking one reads that problem');
  check(await until(() => overlay.locator('.status-line').textContent().then((t) => /Watching/.test(t ?? ''))), '…and watches the work again');

  // 10b. Dragged to the left edge, the bubble opens on its other side, and still fits.
  await overlay.evaluate(() => {
    window.myta.overlay.drag({ dx: -1600, dy: -200, end: false });
    window.myta.overlay.drag({ dx: -1600, dy: -200, end: true });
  });
  await overlay.locator('.tools .tool', { hasText: 'Hint' }).click();
  await until(() => overlay.locator('.card .title', { hasText: /Hint/ }).isVisible());
  await snap(overlay, '10b-left-hint');
  await overlay.locator('.tool.more').click();
  await snap(overlay, '10c-left-menu');
  await overlay.locator('.tool.more').click();

  // 11. A nap, and a tap wakes it (it reads the page again: one problem this time).
  writeFileSync(scriptFile, JSON.stringify(script));
  await overlay.locator('.tool.more').click();
  await overlay.getByRole('menuitem', { name: /Take a nap/ }).click();
  check(await until(() => overlay.locator('.status-line').textContent().then((t) => /Napping/.test(t ?? ''))), 'a nap says "Napping · tap me"');
  check(await overlay.locator('.tools .tool', { hasText: 'Hint' }).isVisible(), '…and the tools stay on screen');
  await snap(overlay, '11-napping');
  await overlay.locator('.char').click();
  check(await until(() => overlay.locator('.status-line').textContent().then((t) => /Watching/.test(t ?? ''))), 'a tap wakes it up and it watches again');
} catch (e) {
  console.log(`FAIL  crashed: ${e instanceof Error ? e.stack : e}`);
  failures++;
} finally {
  await app.close().catch(() => undefined);
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll end-to-end checks passed');
process.exit(failures ? 1 : 0);
