import { DEFAULT_DIFFICULTY, MAX_DIFFICULTY, MIN_DIFFICULTY } from '../shared/constants';
import type { Checkpoint, Domain, ProblemCandidate, SolverResult, WorkFormat } from '../shared/types';
import { quotesProblem } from './concept';
import { courseBlock, type CourseTopics } from './syllabus';
import { generateJson, type LlmCtx, type Part } from './llmClient';
import { COURSE_RULE, SOLVER_SYSTEM } from './prompts';
import { DOMAINS, SOLVER_SCHEMA, WORK_FORMATS } from './schemas';

type Raw = Partial<Record<keyof SolverResult | 'verification' | 'choice', unknown>>;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : []);
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function checkpoints(v: unknown): Checkpoint[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((c) => ({ label: text((c as Checkpoint)?.label), expected: text((c as Checkpoint)?.expected) }))
    .filter((c) => c.label && c.expected)
    .slice(0, 8);
}

/** Tidies what the model said into a SolverResult: unknown names fall back to safe values, numbers are clamped. */
export function normalizeSolution(r: Raw): SolverResult {
  const domain = DOMAINS.includes(r.domain as Domain) ? (r.domain as Domain) : 'other';
  const workFormat = WORK_FORMATS.includes(r.workFormat as WorkFormat) ? (r.workFormat as WorkFormat) : 'equations';
  const confidence = r.keyConfidence === 'low' || r.keyConfidence === 'medium' ? r.keyConfidence : 'high';
  const minutes = Math.round(Number(r.expectedMinutes));
  const problemText = text(r.problemText);
  const conceptTags = strings(r.conceptTags);
  const videoConcept = text(r.videoConcept) || conceptTags[0] || '';
  // A search that quotes the problem would find answers to it, not an explanation of the idea.
  const rawQuery = text(r.videoQuery);
  const candidates = (Array.isArray(r.candidates) ? r.candidates : [])
    .map((c) => ({ label: text((c as ProblemCandidate)?.label).slice(0, 40), summary: text((c as ProblemCandidate)?.summary).slice(0, 90), studentWorking: (c as ProblemCandidate)?.studentWorking === true }))
    .filter((c) => c.label)
    .slice(0, 6);
  const pageKind = (['problem', 'notes', 'mixed', 'nothing'] as const).find((k) => k === r.pageKind);
  // Asking only makes sense with at least two problems to pick from.
  const ambiguous = r.ambiguous === true && candidates.length >= 2;
  const videoQuery = videoConcept ? (!rawQuery || quotesProblem(rawQuery, problemText) ? `${videoConcept} explained` : rawQuery) : '';
  return {
    problemDetected: !!r.problemDetected,
    problemText,
    finalAnswer: text(r.finalAnswer),
    answerForms: strings(r.answerForms).slice(0, 12),
    keySteps: strings(r.keySteps),
    conceptTags,
    misconceptions: strings(r.misconceptions),
    answerKeyPhrases: strings(r.answerKeyPhrases),
    difficulty: Math.min(MAX_DIFFICULTY, Math.max(MIN_DIFFICULTY, Math.round(Number(r.difficulty) || DEFAULT_DIFFICULTY))),
    problemKind: text(r.problemKind),
    domain,
    workFormat,
    givens: text(r.givens),
    checkpoints: checkpoints(r.checkpoints),
    keyConfidence: confidence,
    expectedMinutes: Number.isFinite(minutes) && minutes > 0 ? Math.min(180, minutes) : undefined,
    videoConcept,
    videoQuery,
    pageKind,
    candidates,
    ambiguous,
  };
}

/** A problem file the student uploaded: a photo (PNG/JPEG/WebP) or a PDF, as base64. */
export interface ProblemUpload {
  data: string;
  mimeType: string;
  name: string;
}

export interface SolveInput {
  /** Base64 JPEG of the window the student is working in. */
  screen?: string | null;
  /** The problem itself, when the student uploaded it or took a photo of it. */
  upload?: ProblemUpload | null;
  /** The problem as the student typed or pasted it into the question box. */
  typed?: string;
  /** Which problem in the upload or on screen ("3b"), when the student said. */
  which?: string;
  /** What the course has covered, when the student gave a syllabus or topic list. */
  course?: CourseTopics | null;
}

/** The parts of the solver call, in order: the course first (it changes least), then the problem file, then the screen. */
export function solverParts(input: SolveInput): Part[] {
  const parts: Part[] = [];
  const course = courseBlock(input.course);
  if (course) parts.push({ text: `${course}\n\n${COURSE_RULE}` });
  if (input.typed?.trim()) parts.push({ text: `The problem, as the student typed it:
${input.typed.trim().slice(0, 4000)}` });
  if (input.upload) parts.push({ text: `The problem, uploaded by the student (${input.upload.name}):` }, { file: input.upload.data, mimeType: input.upload.mimeType });
  if (input.screen) parts.push({ text: input.upload ? 'Screenshot of the window where the student is working on it:' : 'Screenshot of the window the student is working in:' }, { image: input.screen });
  parts.push({ text: input.which ? `The student is working on problem "${input.which}". Solve exactly that one.` : 'Solve the problem the student is working on.' });
  return parts;
}

/**
 * Call 1: the hidden solver. Its output stays in the main process and is never sent to the UI. It reads figures (a circuit's schematic)
 * from the picture, because every later message is checked against it. `fast` is the quick model with a little thinking (back in a few
 * seconds); `smart` is the stronger model with room to think, whose key replaces the quick one when it lands.
 */
export async function solve(ctx: LlmCtx, input: SolveInput, tier: 'fast' | 'smart' = 'smart'): Promise<SolverResult> {
  if (!input.screen && !input.upload && !input.typed?.trim()) throw new Error('Nothing to read the problem from.');
  const r = await generateJson<Raw>(ctx, {
    system: SOLVER_SYSTEM,
    parts: solverParts(input),
    schema: SOLVER_SCHEMA,
    schemaName: 'private_solution',
    kind: tier === 'fast' ? 'solve-quick' : 'solve',
    tier,
    // The quick read thinks a little so it's back in seconds; the careful one takes its time.
    effort: tier === 'fast' ? 'low' : 'medium',
    maxTokens: tier === 'fast' ? 8000 : 12_000,
    temperature: 0.1,
    timeoutMs: tier === 'fast' ? 45_000 : 120_000,
    // The quick read normally takes a few seconds: a model still silent after 6 s is probably overloaded, so a backup is asked too.
    hedgeMs: tier === 'fast' ? 6000 : undefined,
  });
  return normalizeSolution(r);
}
