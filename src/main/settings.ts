// Settings live in one JSON file in the app's data folder. The API keys are encrypted with Windows' own per-user encryption (DPAPI, through
// Electron's safeStorage) and never go back to a renderer; setup only learns whether a key is saved and its last four characters.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CourseTopics } from '../core/ai/syllabus';
import { migrateCourse, type ActiveClass, type ClassInfo } from '../core/shared/classes';
import { DEFAULT_MODEL, DEFAULT_RPM, DEFAULT_SOLVER_MODEL } from '../core/shared/constants';
import { DEFAULT_SPRITE, type MySprite, type SettingsView, type SpritePos } from '../core/shared/ui';

export interface Crypto {
  available(): boolean;
  encrypt(s: string): string;
  decrypt(s: string): string;
}

export interface StoredSettings {
  geminiKey: string;
  serpKey: string;
  /** True when the keys above are encrypted. */
  encrypted: boolean;
  model: string;
  solverModel: string;
  rpm: number;
  /** Older settings: one list of topics. Moved into `classes` on load. */
  course?: CourseTopics | null;
  /** Course topics, per class. */
  classes: ClassInfo[];
  /** Which class tanrushu follows: "auto" (by the notes window's title), "none", or a class id. */
  activeClass: ActiveClass;
  sprite: MySprite;
  spritePos: SpritePos | null;
  /** Leave the monkey and the red box out of screenshots and screen recordings (on by default, so the model never reads them). */
  hideFromCapture: boolean;
  /** Show tanrushu in every app, not only note-taking and whiteboard apps (off by default). */
  showEverywhere: boolean;
  solved: { day: string; count: number };
  /** Video moments found earlier, by concept. */
  videoCache: Record<string, unknown>;
}

export const HOTKEY = 'CommandOrControl+Shift+M';

const DEFAULTS: StoredSettings = {
  geminiKey: '',
  serpKey: '',
  encrypted: false,
  model: DEFAULT_MODEL,
  solverModel: DEFAULT_SOLVER_MODEL,
  rpm: DEFAULT_RPM,
  classes: [],
  activeClass: 'auto',
  sprite: DEFAULT_SPRITE,
  spritePos: null,
  hideFromCapture: true,
  showEverywhere: false,
  solved: { day: '', count: 0 },
  videoCache: {},
};

const today = (now = new Date()) => `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;

export class SettingsStore {
  private s: StoredSettings;

  constructor(
    private file: string,
    private crypto: Crypto,
    private env: Record<string, string | undefined> = {},
  ) {
    this.s = this.load();
  }

  private load(): StoredSettings {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoredSettings>;
      const classes = Array.isArray(raw.classes) ? raw.classes : migrateCourse(raw.course);
      const { course: _old, ...rest } = raw;
      return { ...DEFAULTS, ...rest, classes, sprite: raw.sprite?.mode ? raw.sprite : DEFAULT_SPRITE, solved: raw.solved ?? DEFAULTS.solved };
    } catch {
      return { ...DEFAULTS };
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.s, null, 2));
    renameSync(tmp, this.file);
  }

  private reveal(v: string): string {
    if (!v) return '';
    if (!this.s.encrypted) return v;
    try {
      return this.crypto.decrypt(v);
    } catch {
      return '';
    }
  }

  get raw(): Readonly<StoredSettings> {
    return this.s;
  }

  /** The Gemini key: the saved one, or MYTA_GEMINI_KEY from the environment. */
  geminiKey(): string {
    return this.reveal(this.s.geminiKey) || this.env.MYTA_GEMINI_KEY || '';
  }

  serpKey(): string {
    return this.reveal(this.s.serpKey) || this.env.MYTA_SERP_KEY || '';
  }

  setKeys(k: { gemini?: string; serp?: string }): void {
    // Re-encrypt both whenever either changes, so the file never mixes encrypted and plain keys.
    const gemini = k.gemini !== undefined ? k.gemini.trim() : this.reveal(this.s.geminiKey);
    const serp = k.serp !== undefined ? k.serp.trim() : this.reveal(this.s.serpKey);
    const enc = this.crypto.available();
    this.s.encrypted = enc;
    this.s.geminiKey = gemini && enc ? this.crypto.encrypt(gemini) : gemini;
    this.s.serpKey = serp && enc ? this.crypto.encrypt(serp) : serp;
    this.save();
  }

  update(patch: Partial<Pick<StoredSettings, 'model' | 'solverModel' | 'classes' | 'activeClass' | 'sprite' | 'spritePos' | 'hideFromCapture' | 'showEverywhere' | 'videoCache'>>): void {
    Object.assign(this.s, patch);
    this.save();
  }

  solvedToday(): number {
    return this.s.solved.day === today() ? this.s.solved.count : 0;
  }

  addSolved(): number {
    const d = today();
    this.s.solved = { day: d, count: (this.s.solved.day === d ? this.s.solved.count : 0) + 1 };
    this.save();
    return this.s.solved.count;
  }

  view(): SettingsView {
    const tail = (k: string) => (k ? k.slice(-4) : '');
    const g = this.geminiKey();
    const sp = this.serpKey();
    return {
      gemini: { saved: !!g, tail: tail(g) },
      serp: { saved: !!sp, tail: tail(sp) },
      model: this.s.model,
      solverModel: this.s.solverModel,
      classes: this.s.classes,
      activeClass: this.s.activeClass,
      hideFromCapture: this.s.hideFromCapture,
      showEverywhere: this.s.showEverywhere,
      sprite: this.s.sprite,
      hotkey: HOTKEY.replace('CommandOrControl', 'Ctrl'),
    };
  }
}
