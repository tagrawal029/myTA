// Finding the clip fast. The old flow waited for the student to ask, then made three slow calls in a row (name the concept, search,
// have Gemini pick and watch). Now the search starts the moment the problem is solved, with the concept and search the answer key already
// named, and the clip is picked on the spot from the search results (a chapter whose title matches the concept, else the top result).
// Gemini watching the video to find the exact minute still happens, but in the background with a short time limit: when it finishes
// before the student asks, they get its minute; when it doesn't, they get the clip right away and the minute is improved if it lands.
import type { LlmCtx } from '../ai/llmClient';
import { watchForMoment, clampSegment } from '../ai/videoTimestamp';
import type { VideoMoment } from '../shared/types';
import { VideoCache } from './cache';
import { searchYouTube, type VideoCandidate } from './youtube';

/** How long Gemini may spend watching a video in the background. */
export const WATCH_BUDGET_MS = 25_000;
/** Longest video worth watching for one moment. */
const MAX_WATCH_SEC = 25 * 60;

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
const STOP = new Set(['the', 'and', 'for', 'with', 'how', 'what', 'intro', 'introduction', 'explained', 'part', 'video', 'lesson']);

/** How well a chapter title matches the concept: the share of the concept's words it contains. */
export function chapterScore(title: string, concept: string): number {
  const c = words(concept);
  if (!c.size) return 0;
  const t = words(title);
  let hit = 0;
  for (const w of c) if (t.has(w) || [...t].some((x) => x.startsWith(w.slice(0, 5)) && w.length >= 5)) hit++;
  return hit / c.size;
}

/** The clip to show right now, from the search results alone: no model call. */
export function quickMoment(cands: VideoCandidate[], concept: string): VideoMoment | null {
  if (!cands.length) return null;
  let best: { c: VideoCandidate; start: number; end: number; score: number } | null = null;
  // Look at the top few: a slightly lower result with a chapter that names the concept beats a top result we'd play from 0:00.
  for (const [i, c] of cands.slice(0, 4).entries()) {
    const chapters = c.chapters.map((ch, j) => ({ ...ch, next: c.chapters[j + 1]?.startSec }));
    const top = chapters.map((ch) => ({ ch, s: chapterScore(ch.title, concept) })).sort((a, b) => b.s - a.s)[0];
    const score = (top && top.s >= 0.5 ? 2 + top.s : 0) - i * 0.4;
    const start = top && top.s >= 0.5 ? top.ch.startSec : 0;
    const end = top && top.s >= 0.5 ? (top.ch.next ?? start + 240) : Math.min(c.lengthSec || 300, 300);
    if (!best || score > best.score) best = { c, start, end, score };
  }
  const { c, start, end, score } = best!;
  return {
    videoId: c.videoId,
    title: c.title,
    channel: c.channel,
    ...clampSegment(c, start, end),
    why: `How ${concept} works`,
    concept,
    source: score >= 2 ? 'chapters' : 'metadata',
    lengthSec: c.lengthSec || undefined,
  };
}

export interface FinderDeps {
  search: (serpKey: string, query: string) => Promise<VideoCandidate[]>;
  watch: (ctx: LlmCtx, c: VideoCandidate, concept: string) => Promise<{ start: number; end: number; why: string } | null>;
}
const realDeps: FinderDeps = { search: searchYouTube, watch: watchForMoment };

interface Pending {
  quick: Promise<VideoMoment | null>;
  /** Resolves when the background watch is done (or gave up); the better moment is then in `best`. */
  refined: Promise<void>;
  best: VideoMoment | null;
}

export class VideoFinder {
  private pending = new Map<string, Pending>();

  constructor(
    private cache: VideoCache,
    private keys: () => { serpKey: string; ctx: LlmCtx | null },
    private deps: FinderDeps = realDeps,
  ) {}

  private key(concept: string) {
    return concept.toLowerCase().trim();
  }

  /** Starts finding a clip for this concept now, so it is ready when the student asks. Safe to call more than once. */
  prefetch(concept: string, query: string): void {
    if (!concept || this.pending.has(this.key(concept))) return;
    const p: Pending = { quick: Promise.resolve(null), refined: Promise.resolve(), best: null };
    this.pending.set(this.key(concept), p);
    p.quick = (async () => {
      const cached = await this.cache.get(concept).catch(() => null);
      if (cached) return (p.best = cached);
      const { serpKey } = this.keys();
      let cands: VideoCandidate[] = [];
      try {
        cands = await this.deps.search(serpKey, query || `${concept} explained`);
      } catch (e) {
        // Out of searches or offline: an older clip for this concept is better than nothing.
        const stale = await this.cache.get(concept, true).catch(() => null);
        if (stale) return (p.best = stale);
        this.pending.delete(this.key(concept));
        throw e;
      }
      const quick = quickMoment(cands, concept);
      p.best = quick;
      if (quick) {
        void this.cache.set(concept, quick).catch(() => undefined);
        if (quick.source !== 'chapters') p.refined = this.refine(p, cands.find((c) => c.videoId === quick.videoId)!, concept);
      }
      return quick;
    })();
    p.quick.catch(() => undefined);
  }

  private async refine(p: Pending, c: VideoCandidate, concept: string): Promise<void> {
    const { ctx } = this.keys();
    if (!ctx || (c.lengthSec && c.lengthSec > MAX_WATCH_SEC)) return;
    try {
      const w = await Promise.race([this.deps.watch(ctx, c, concept), new Promise<null>((r) => setTimeout(() => r(null), WATCH_BUDGET_MS))]);
      if (!w || !p.best || p.best.videoId !== c.videoId) return;
      p.best = { ...p.best, ...clampSegment(c, w.start, w.end), why: w.why || p.best.why, source: 'video' };
      await this.cache.set(concept, p.best).catch(() => undefined);
    } catch {
      /* the quick pick stands */
    }
  }

  /**
   * The clip for this concept, as soon as there is one. Waits for the search (a couple of seconds at most when it was prefetched),
   * and for the background watch only up to `waitForMinuteMs`.
   */
  async get(concept: string, query: string, waitForMinuteMs = 0): Promise<VideoMoment | null> {
    this.prefetch(concept, query);
    const p = this.pending.get(this.key(concept));
    if (!p) return null;
    const quick = await p.quick;
    if (waitForMinuteMs > 0 && quick && quick.source === 'metadata') await Promise.race([p.refined, new Promise((r) => setTimeout(r, waitForMinuteMs))]);
    return p.best ?? quick;
  }

  /** The best moment known so far without waiting (null while the search is still running). */
  peek(concept: string): VideoMoment | null {
    return this.pending.get(this.key(concept))?.best ?? null;
  }

  /** Resolves when the background watch for this concept is done, so the clip's minute can be updated on screen. */
  whenRefined(concept: string): Promise<VideoMoment | null> {
    const p = this.pending.get(this.key(concept));
    if (!p) return Promise.resolve(null);
    return p.refined.then(() => p.best);
  }
}

/** The address that opens the clip at its minute. */
export const clipUrl = (m: Pick<VideoMoment, 'videoId' | 'start'>) => `https://www.youtube.com/watch?v=${m.videoId}&t=${Math.max(0, Math.floor(m.start))}s`;

/** "2:14" for 134 seconds, "1:02:03" past an hour. */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}
