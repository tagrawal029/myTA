// Course topics, saved per class. Each class has its own list of topics (what the class has covered so far), and tanrushu follows one of
// them: the one the student picked, or, on Auto, the class whose name (or one of its keywords) is in the title of the notes window
// ("Calc I - OneNote" → Calc I). The topics of the class in use go to every model call that talks about methods.
import type { CourseTopics } from '../ai/syllabus';

export interface ClassInfo {
  id: string;
  name: string;
  /** The colour of its spine on the bookshelf in setup. */
  color: string;
  topics: string[];
  /** How far the class has got, in the student's words ("through week 6"). */
  coveredUpTo: string;
  /** Words that, in a notes window's title, mean this class (the name always counts too). */
  keywords: string[];
  updatedAt: number;
}

/** Which class tanrushu follows: "auto" (match the notes window's title), "none", or a class id. */
export type ActiveClass = 'auto' | 'none' | string;

export const CLASS_COLORS = ['#c0573f', '#3f7cc0', '#3f9a6b', '#c08a2b', '#7a55b8', '#2f9aa3', '#b8487a', '#5c6b3a'];

const MAX_CLASSES = 24;
const MAX_TOPICS = 80;

export function newClass(name: string, existing: ClassInfo[], now = Date.now()): ClassInfo {
  return {
    id: `c${now.toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    name: name.trim().slice(0, 40) || 'New class',
    color: CLASS_COLORS[existing.length % CLASS_COLORS.length],
    topics: [],
    coveredUpTo: '',
    keywords: [],
    updatedAt: now,
  };
}

/** Tidies a class coming back from the setup page: trimmed, de-duplicated, sensible lengths. */
export function normalizeClass(c: Partial<ClassInfo> & { id: string }, now = Date.now()): ClassInfo {
  const uniq = (xs: unknown, max: number, len: number) => {
    const seen = new Set<string>();
    return (Array.isArray(xs) ? xs : [])
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.replace(/\s+/g, ' ').trim().slice(0, len))
      .filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()))
      .slice(0, max);
  };
  return {
    id: c.id,
    name: (c.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Untitled class',
    color: typeof c.color === 'string' && /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : CLASS_COLORS[0],
    topics: uniq(c.topics, MAX_TOPICS, 80),
    coveredUpTo: (c.coveredUpTo ?? '').trim().slice(0, 80),
    keywords: uniq(c.keywords, 10, 40),
    updatedAt: now,
  };
}

/** Puts a class in the list (replacing the one with the same id), keeping at most 24. */
export function upsertClass(list: ClassInfo[], c: ClassInfo): ClassInfo[] {
  const i = list.findIndex((x) => x.id === c.id);
  if (i >= 0) return list.map((x, j) => (j === i ? c : x));
  return [...list, c].slice(0, MAX_CLASSES);
}

/** Merges topics found in a syllabus into a class's own list, keeping what the student already had first. */
export function mergeTopics(have: string[], found: string[]): string[] {
  const seen = new Set(have.map((t) => t.toLowerCase()));
  return [...have, ...found.filter((t) => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))].slice(0, MAX_TOPICS);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Whether a window title names this class (its name or one of its keywords, as whole words). */
export function titleMatches(c: Pick<ClassInfo, 'name' | 'keywords'>, title: string): boolean {
  const t = ` ${norm(title)} `;
  return [c.name, ...c.keywords].map(norm).some((k) => k.length >= 2 && t.includes(` ${k} `));
}

/** The class tanrushu follows right now, given the student's choice and the title of the window they're working in. */
export function resolveClass(classes: ClassInfo[], active: ActiveClass, windowTitle: string): ClassInfo | null {
  if (active === 'none') return null;
  if (active !== 'auto') return classes.find((c) => c.id === active) ?? null;
  // Auto: the class named in the window title; the longest match wins ("Calc II" over "Calc").
  const hits = classes.filter((c) => titleMatches(c, windowTitle));
  return hits.sort((a, b) => b.name.length - a.name.length)[0] ?? null;
}

/** What the model calls get. Null when the class has no topics (then nothing limits the methods). */
export function toCourse(c: ClassInfo | null): CourseTopics | null {
  if (!c || !c.topics.length) return null;
  return { course: c.name, coveredUpTo: c.coveredUpTo, topics: c.topics, updatedAt: c.updatedAt };
}

/** Settings saved before classes existed had one list of topics: it becomes the first class. */
export function migrateCourse(old: CourseTopics | null | undefined, now = Date.now()): ClassInfo[] {
  if (!old || !old.topics?.length) return [];
  return [normalizeClass({ id: 'c-first', name: old.course || 'My class', color: CLASS_COLORS[0], topics: old.topics, coveredUpTo: old.coveredUpTo }, now)];
}
