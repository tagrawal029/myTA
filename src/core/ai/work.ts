// Call 3: look at the student's work against the private answer key.
// Reads while they write produce private notes plus, for a mistake, the red box and a message; the check they ask for ("Check my work")
// also writes a message for work that is on track or unclear. Every message still goes through the leak guard.
//
// Image 1 is always the window the student works in. The problem the student uploaded, if any, comes second.
import type { Box, CopyState, Readability, SolverResult } from '../shared/types';
import { generateJson, type LlmCtx, type Part } from './llmClient';
import { LOCATE_SYSTEM, WORK_SYSTEM } from './prompts';
import { LOCATE_SCHEMA, WORK_SCHEMA } from './schemas';
import type { CourseTopics } from './syllabus';
import { answerKeyBlock, courseRuleBlock } from './tutor';

export type ReviewStatus = 'no_work' | 'on_track' | 'mistake' | 'solved' | 'unclear';

export interface WorkReview {
  status: ReviewStatus;
  differentProblem: boolean;
  /** The student copied the problem onto their work, finished writing it, and it differs from the real one. Always comes with status "mistake". */
  copiedWrong: boolean;
  copyState: CopyState;
  /** Private: may name the mistake. */
  observation: string;
  studentMessage: string;
  box: Box | null;
  /** Private: the smallest wrong piece of the work as the student wrote it (what the box should hug). */
  wrongPart: string;
  /** The student's own writing as the model read it, and how well it could read it. */
  workRead: string;
  readability: Readability;
}

export interface ReviewArgs {
  hidden: SolverResult;
  /** Base64 JPEG of the window where the student's work is (image 1; the box refers to this one). */
  workImage: string;
  /** The problem the student uploaded, when it is a picture or a PDF. Sent only on the first read of a problem (it never changes). */
  problemFile?: { data: string; mimeType: string } | null;
  /** The previous private observation, so the reviewer can tell whether a mistake was fixed. */
  previous: string;
  /** True when the student asked to check their work. */
  final: boolean;
  /** Why it is looking now, e.g. "the work changed and then sat still". Context only. */
  why?: string;
  /** Seconds since the student last wrote anything when the snapshot was taken (a line was just finished when this is small). */
  idleSec?: number | null;
  course?: CourseTopics | null;
  /** Set when the previous draft of the student message was rejected by the leak guard. */
  leakFeedback?: string;
}

const STATUSES: ReviewStatus[] = ['no_work', 'on_track', 'mistake', 'solved', 'unclear'];
const READABILITY: Readability[] = ['clear', 'hard_to_read', 'nothing_written'];
const COPY_STATES: CopyState[] = ['not_copied', 'in_progress', 'complete'];
const MAX_READ_CHARS = 240;

/** Accepts the model's [ymin, xmin, ymax, xmax] (0..1000); drops boxes that are malformed, tiny, or cover nearly everything. */
export function normalizeBox(raw: unknown): Box | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const n = raw.map((v) => Math.round(Math.min(1000, Math.max(0, Number(v)))));
  if (n.some((v) => !Number.isFinite(v))) return null;
  const [y0, x0, y1, x1] = n;
  if (y1 - y0 < 5 || x1 - x0 < 5) return null;
  if ((y1 - y0) * (x1 - x0) > 0.9 * 1000 * 1000) return null;
  return [y0, x0, y1, x1];
}

export function normalizeReview(r: Partial<Record<keyof WorkReview, unknown>>): WorkReview {
  const status = STATUSES.includes(r.status as ReviewStatus) ? (r.status as ReviewStatus) : 'unclear';
  const differentProblem = r.differentProblem === true;
  // A copy can only be wrong once it is finished. Without the model saying so, it isn't.
  const copyState: CopyState = COPY_STATES.includes(r.copyState as CopyState) ? (r.copyState as CopyState) : 'not_copied';
  const copiedWrong = r.copiedWrong === true && copyState === 'complete' && !differentProblem;
  const workRead = typeof r.workRead === 'string' ? r.workRead.replace(/\s+/g, ' ').trim().slice(0, MAX_READ_CHARS) : '';
  let readability: Readability = READABILITY.includes(r.readability as Readability) ? (r.readability as Readability) : workRead ? 'clear' : 'nothing_written';
  // The two fields must agree: no transcription can't be "clear", and a transcription can't be "nothing written".
  if (!workRead && readability === 'clear') readability = 'nothing_written';
  if (workRead && readability === 'nothing_written') readability = 'hard_to_read';
  // A mistake the model blamed only on a copy that is still being written isn't one.
  const unfinishedCopyOnly = r.copiedWrong === true && copyState !== 'complete' && status === 'mistake';
  const effective: ReviewStatus = unfinishedCopyOnly ? 'on_track' : status;
  return {
    status: differentProblem ? 'unclear' : copiedWrong ? 'mistake' : effective,
    differentProblem,
    copiedWrong,
    copyState,
    observation: typeof r.observation === 'string' ? r.observation.trim() : '',
    studentMessage: typeof r.studentMessage === 'string' ? r.studentMessage.trim() : '',
    box: (effective === 'mistake' || copiedWrong) && !differentProblem ? normalizeBox(r.box) : null,
    wrongPart: typeof r.wrongPart === 'string' ? r.wrongPart.trim().slice(0, 120) : '',
    workRead,
    readability,
  };
}

/** The parts of a review call: the key and course first (they don't change), then the pictures, then what changes every call. */
export function reviewParts(a: ReviewArgs): Part[] {
  const fixed = [answerKeyBlock(a.hidden), `Problem (from the answer key):\n${a.hidden.problemText}`, courseRuleBlock(a.course)].filter(Boolean).join('\n\n');
  const lineDone = a.idleSec != null && a.idleSec >= 1 && a.idleSec < 6 && !a.final;
  const changing = [
    `Mode: ${a.final ? 'FINAL (the student asked to check their work)' : 'PERIODIC (a quick look while they work)'}`,
    a.why && `Why you are being asked now: ${a.why}`,
    a.idleSec != null &&
      (lineDone
        ? `The student stopped writing ${a.idleSec} s before this snapshot: a line has just been finished. Judge it, and the lines before it. (Do not call a copy of the problem wrong unless it is complete.)`
        : a.idleSec === 0
          ? 'The student is writing right now: the last line may be unfinished.'
          : ''),
    `Your previous private observation: ${a.previous || '(none)'}`,
    a.leakFeedback && `Your previous studentMessage was REJECTED because it leaked: ${a.leakFeedback}. Point to where the mistake is without saying what the right answer or step is.`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const parts: Part[] = [{ text: fixed }, { text: 'IMAGE 1: the window where the student works (the box refers to this image).' }, { image: a.workImage }];
  if (a.problemFile) parts.push({ text: 'The problem as the student uploaded it:' }, { file: a.problemFile.data, mimeType: a.problemFile.mimeType });
  parts.push({ text: changing });
  return parts;
}

export async function reviewWork(ctx: LlmCtx, a: ReviewArgs): Promise<WorkReview> {
  const hard = (a.hidden.difficulty ?? 3) >= 4 || a.hidden.workFormat === 'diagram' || a.hidden.workFormat === 'mixed';
  const r = await generateJson<Partial<Record<keyof WorkReview, unknown>>>(ctx, {
    system: WORK_SYSTEM,
    parts: reviewParts(a),
    schema: WORK_SCHEMA,
    schemaName: 'work_review',
    kind: a.final ? 'check-work' : 'review',
    // The quick reads while they write think least, so a flagged line shows up a couple of seconds after it was written. A check they
    // asked for, and a hard or drawn problem (where each step has to be recomputed), get a little more thinking.
    effort: a.final ? 'medium' : hard ? 'low' : 'minimal',
    maxTokens: 4000,
    temperature: 0.2,
    timeoutMs: a.final ? 60_000 : 45_000,
  });
  return normalizeReview(r);
}

/**
 * The second, close look at a mistake: a zoomed-in picture of where it is and the piece that is wrong. Returns where that piece is in the
 * close-up (0..1000), or null when it isn't there. A full-window screenshot puts a small handwritten term at a handful of pixels, so the
 * first box is often a line off, or the whole line; in the close-up the piece is big and the box can hug it.
 */
export async function locateMistake(ctx: LlmCtx, closeUp: string, wrongPart: string): Promise<Box | null> {
  const r = await generateJson<{ seen?: unknown; found?: unknown; box?: unknown }>(ctx, {
    system: LOCATE_SYSTEM,
    parts: [{ text: 'The close-up:' }, { image: closeUp }, { text: `The piece with the mistake, as the student wrote it: ${wrongPart}` }],
    schema: LOCATE_SCHEMA,
    schemaName: 'locate',
    kind: 'locate',
    effort: 'minimal',
    maxTokens: 800,
    temperature: 0,
    timeoutMs: 8000,
    hedgeMs: 4000,
  });
  return r.found === true ? normalizeBox(r.box) : null;
}
