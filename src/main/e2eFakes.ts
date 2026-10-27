// End-to-end test only (MYTA_E2E=1): Gemini and SerpApi are answered from a script file instead of the network, and every request is
// logged, so the test can drive the real app through a whole session and check what was sent. Which canned review comes back depends
// on which picture is currently "on screen": the test writes that picture's name next to the shot file.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

interface Script {
  solve?: unknown;
  reviews?: Record<string, unknown>;
  hint?: unknown[];
  judge?: unknown;
  syllabus?: unknown;
  moment?: unknown;
  pick?: unknown;
  locate?: unknown;
  serp?: unknown;
  delays?: Record<string, number>;
}

const KINDS: [RegExp, string][] = [
  [/^You are a private answer key/, 'solve'],
  [/^You watch a student's screen/, 'review'],
  [/^You are myTA/, 'hint'],
  [/^You audit tutor messages/, 'judge'],
  [/^You read a course syllabus/, 'syllabus'],
  [/^You are shown a YouTube video/, 'moment'],
  [/^You are shown a close-up/, 'locate'],
  [/^Pick the best video/, 'pick'],
  [/^Reply with ok=true/, 'ping'],
];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const gemini = (out: unknown) => json({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } });

export function installE2eFetch(scriptPath: string, logPath: string): void {
  const real = globalThis.fetch;
  const script = (): Script => (scriptPath && existsSync(scriptPath) ? (JSON.parse(readFileSync(scriptPath, 'utf8')) as Script) : {});
  const log = (entry: Record<string, unknown>) => logPath && appendFileSync(logPath, `${JSON.stringify({ t: Date.now(), ...entry })}\n`);
  const currentShot = () => {
    const f = `${process.env.MYTA_E2E_SHOT ?? ''}.name`;
    return existsSync(f) ? readFileSync(f, 'utf8').trim() : '';
  };
  let hints = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const s = script();
    if (url.includes('generativelanguage.googleapis.com')) {
      if (!init?.body) return json({ models: [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-4-argon', supportedGenerationMethods: ['generateContent'] }] });
      const body = JSON.parse(String(init.body)) as { systemInstruction?: { parts?: { text?: string }[] }; contents?: { parts?: Record<string, unknown>[] }[] };
      const system = body.systemInstruction?.parts?.[0]?.text ?? '';
      const kind = KINDS.find(([re]) => re.test(system))?.[1] ?? 'unknown';
      const parts = body.contents?.[0]?.parts ?? [];
      const texts = parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('\n');
      const files = parts.filter((p) => p.inlineData).map((p) => (p.inlineData as { mimeType: string }).mimeType);
      const shot = currentShot();
      const model = /models\/([^:/?]+):/.exec(url)?.[1] ?? '';
      log({ api: 'gemini', kind, model, shot, files, text: texts.slice(0, 6000) });
      const wait = s.delays?.[kind] ?? 60;
      await new Promise((r) => setTimeout(r, wait));
      switch (kind) {
        case 'solve':
          return gemini(s.solve);
        case 'review':
          return gemini(s.reviews?.[shot] ?? { differentProblem: false, readability: 'clear', workRead: '', copyState: 'not_copied', copiedWrong: false, observation: '', status: 'on_track', box: [], studentMessage: '' });
        case 'hint':
          return gemini((s.hint ?? [])[hints++ % Math.max(1, s.hint?.length ?? 1)] ?? { replyAssessment: 'none', hintLevel: 1, message: 'What is the problem asking you to find?', missingPrerequisite: '' });
        case 'judge':
          return gemini(s.judge ?? { leaks: false, reason: '' });
        case 'syllabus':
          return gemini(s.syllabus);
        case 'moment':
          return gemini(s.moment ?? { explainsIt: false, start: '0:00', end: '0:00', why: '' });
        case 'pick':
          return gemini(s.pick ?? { index: 0, startSec: 0, endSec: 240, why: '' });
        case 'locate':
          return gemini(s.locate ?? { seen: '', found: false, box: [] });
        case 'ping':
          return gemini({ ok: true });
        default:
          return json({ error: { message: `unscripted call: ${system.slice(0, 40)}` } }, 400);
      }
    }
    if (url.includes('serpapi.com')) {
      log({ api: 'serpapi', url: url.replace(/api_key=[^&]+/, 'api_key=KEY') });
      await new Promise((r) => setTimeout(r, s.delays?.serp ?? 80));
      if (url.includes('account.json')) return json({ plan_name: 'Free', total_searches_left: 99 });
      return json(s.serp ?? { video_results: [] });
    }
    return real(input, init);
  }) as typeof fetch;
}
