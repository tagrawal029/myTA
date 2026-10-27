// Optional: what the student's course has covered, so myTA never suggests a way of solving a problem the class hasn't learned yet.
// The student pastes topics, uploads a syllabus (PDF or photo), or both, and says how far the course has got. One model call turns
// that into a short list of topic names, which is saved and passed to every later call that talks about methods.
import { generateJson, type LlmCtx, type Part } from './llmClient';
import { SYLLABUS_SYSTEM } from './prompts';
import { SYLLABUS_SCHEMA } from './schemas';

export interface CourseTopics {
  course: string;
  coveredUpTo: string;
  topics: string[];
  updatedAt: number;
}

export interface SyllabusInput {
  /** Topics or syllabus text the student typed or pasted. */
  text?: string;
  /** A syllabus file (PDF or photo), base64. */
  file?: { data: string; mimeType: string; name: string } | null;
  /** How far the course has got, in the student's words ("week 6", "up to chapter 4"). */
  upTo?: string;
}

const MAX_TOPICS = 60;

/** Tidies the model's answer: trimmed, de-duplicated, at most 60 topics. */
export function normalizeTopics(r: { course?: unknown; coveredUpTo?: unknown; topics?: unknown }, now = Date.now()): CourseTopics {
  const seen = new Set<string>();
  const topics = (Array.isArray(r.topics) ? r.topics : [])
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter((t) => t && t.length <= 80 && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
    .slice(0, MAX_TOPICS);
  return {
    course: typeof r.course === 'string' ? r.course.trim().slice(0, 80) : '',
    coveredUpTo: typeof r.coveredUpTo === 'string' ? r.coveredUpTo.trim().slice(0, 80) : '',
    topics,
    updatedAt: now,
  };
}

/** Topics typed one per line or comma-separated, used as they are when no file was given (no model call needed). */
export function topicsFromList(text: string): string[] {
  return text
    .split(/[\n,;•]+/)
    .map((t) => t.replace(/^\s*[-*\d.)]+\s*/, '').trim())
    .filter((t) => t.length > 1 && t.length <= 80);
}

export async function readSyllabus(ctx: LlmCtx, input: SyllabusInput): Promise<CourseTopics> {
  const parts: Part[] = [];
  if (input.file) parts.push({ text: `Syllabus file (${input.file.name}):` }, { file: input.file.data, mimeType: input.file.mimeType });
  if (input.text?.trim()) parts.push({ text: `What the student wrote:\n${input.text.trim().slice(0, 20_000)}` });
  if (!parts.length) throw new Error('Give me a syllabus file or some topics first.');
  parts.push({ text: input.upTo?.trim() ? `How far the course has got: ${input.upTo.trim()}` : 'The student did not say how far the course has got.' });
  const r = await generateJson<{ course: string; coveredUpTo: string; topics: string[] }>(ctx, {
    system: SYLLABUS_SYSTEM,
    parts,
    schema: SYLLABUS_SCHEMA,
    schemaName: 'course_topics',
    kind: 'syllabus',
    effort: 'low',
    maxTokens: 4000,
    temperature: 0.1,
    timeoutMs: 60_000,
  });
  return normalizeTopics(r);
}

/** The block every method-aware call gets, or "" when the student gave no topics. */
export function courseBlock(c: CourseTopics | null | undefined): string {
  if (!c || !c.topics.length) return '';
  return [
    `=== Course topics covered so far${c.course ? ` (${c.course}${c.coveredUpTo ? `, ${c.coveredUpTo}` : ''})` : c.coveredUpTo ? ` (${c.coveredUpTo})` : ''} ===`,
    c.topics.map((t) => `- ${t}`).join('\n'),
    '=== END ===',
  ].join('\n');
}
