// Setup, laid out like a study desk: a leather-bound sidebar where tanrushu keeps track of what's done, then the keys (two index cards),
// your classes (books on a shelf, each opening into its topics), the sprite, and options. Everything saves as you go.
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { CLASS_COLORS, type ActiveClass, type ClassInfo } from '../../core/shared/classes';
import type { Mood, MySprite, SettingsView } from '../../core/shared/ui';
import { BookLogo } from '../shared/Brand';
import { Shadow } from '../shared/Shadow';
import { Avatar } from '../shared/sprite/Avatar';
import { SpriteStudio } from './SpriteStudio';

const api = window.myta.settings;
const classesApi = window.myta.classes;

type SectionId = 'keys' | 'classes' | 'sprite' | 'options';
type Check = { ok: boolean; detail: string } | null;

/** What tanrushu says in the sidebar, and how it looks saying it. */
interface Say {
  mood: Mood;
  text: string;
}

// ---------------- small pieces ----------------

/** Calls `fn` once things have been still for `ms`. `flush` runs a pending call now (so nothing waiting can land after a newer change). */
function useDebounced(fn: () => Promise<void> | void, ms: number) {
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const last = useRef(fn);
  last.current = fn;
  const schedule = useCallback(() => {
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => {
      t.current = null;
      void last.current();
    }, ms);
  }, [ms]);
  const flush = useCallback(async () => {
    if (!t.current) return;
    clearTimeout(t.current);
    t.current = null;
    await last.current();
  }, []);
  return { schedule, flush };
}

function Switch({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <div className="switch-row">
      <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)}>
        <i />
      </button>
      <span>
        <strong>{label}</strong>
        {hint && <em>{hint}</em>}
      </span>
    </div>
  );
}

function SectionHead({ step, title, sub }: { step: string; title: string; sub: string }) {
  return (
    <header className="section-head">
      <span className="kicker">{step}</span>
      <h2>{title}</h2>
      <p>{sub}</p>
    </header>
  );
}

// ---------------- keys ----------------

function KeyCard({
  name,
  blurb,
  link,
  saved,
  tail,
  value,
  onValue,
  check,
  busy,
}: {
  name: string;
  blurb: string;
  link: string;
  saved: boolean;
  tail: string;
  value: string;
  onValue: (v: string) => void;
  check: Check;
  busy: boolean;
}) {
  const [show, setShow] = useState(false);
  const state = busy ? 'checking' : check ? (check.ok ? 'ok' : 'bad') : saved ? 'saved' : 'empty';
  const pill = { checking: 'Checking…', ok: 'Working', bad: 'Needs a fix', saved: `Saved · …${tail}`, empty: 'Not added' }[state];
  return (
    <article className={`index-card state-${state}`}>
      <div className="card-top">
        <h3>{name}</h3>
        <span className={`pill pill-${state}`}>{pill}</span>
      </div>
      <p className="card-blurb">{blurb}</p>
      <div className="key-field">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          spellCheck={false}
          autoComplete="off"
          placeholder={saved ? 'Saved · paste to replace' : 'Paste your key here'}
          onChange={(e) => onValue(e.target.value)}
          aria-label={`${name} key`}
        />
        <button type="button" className="icon-btn" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide the key' : 'Show the key'} title={show ? 'Hide' : 'Show'}>
          {show ? 'Hide' : 'Show'}
        </button>
        <button type="button" className="ghost-btn" onClick={() => void api.paste().then((t) => t && onValue(t))}>
          Paste
        </button>
      </div>
      <div className="card-foot">
        <button type="button" className="link-btn" onClick={() => void api.open(link)}>
          Get a key ↗
        </button>
        {check && <span className={`check-line ${check.ok ? 'good' : 'bad'}`}>{check.detail}</span>}
      </div>
    </article>
  );
}

function Keys({ view, onView, onBusy }: { view: SettingsView; onView: (v: SettingsView) => void; onBusy: (b: boolean, ok?: boolean) => void }) {
  const [gemini, setGemini] = useState('');
  const [serp, setSerp] = useState('');
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState<{ gemini: Check; serp: Check }>({ gemini: null, serp: null });
  const [models, setModels] = useState(false);
  const [model, setModel] = useState(view.model);
  const [solverModel, setSolverModel] = useState(view.solverModel);
  const dirty = !!gemini.trim() || !!serp.trim() || model !== view.model || solverModel !== view.solverModel;

  const save = async () => {
    setBusy(true);
    onBusy(true);
    setChecks({ gemini: null, serp: null });
    try {
      await api.saveKeys({ gemini: gemini.trim() || undefined, serp: serp.trim() || undefined, model, solverModel });
      const r = await api.test();
      setChecks({ gemini: r.gemini, serp: r.serp });
      onView(r.view);
      setModel(r.view.model);
      setSolverModel(r.view.solverModel);
      setGemini('');
      setSerp('');
      onBusy(false, r.gemini.ok);
    } catch {
      onBusy(false, false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="keys" className="page-section">
      <SectionHead step="Step 1" title="Your keys" sub="Gemini reads your problem and your work and writes the hints. SerpApi finds the short videos. Keys are encrypted on this computer and only ever sent to Google and SerpApi." />
      <div className="card-pair">
        <KeyCard name="Gemini" blurb="Reads, checks and hints." link="https://aistudio.google.com/apikey" saved={view.gemini.saved} tail={view.gemini.tail} value={gemini} onValue={setGemini} check={checks.gemini} busy={busy} />
        <KeyCard name="SerpApi" blurb="Finds the right video, at the right minute." link="https://serpapi.com/manage-api-key" saved={view.serp.saved} tail={view.serp.tail} value={serp} onValue={setSerp} check={checks.serp} busy={busy} />
      </div>
      <div className="action-row">
        <button type="button" className="chunky" disabled={busy || (!dirty && !view.gemini.saved)} onClick={() => void save()}>
          {busy ? 'Testing…' : dirty ? 'Save & test' : 'Test again'}
        </button>
        <button type="button" className="link-btn" onClick={() => setModels((m) => !m)} aria-expanded={models}>
          {models ? 'Hide models' : 'Models'}
        </button>
      </div>
      {models && (
        <div className="models">
          <label>
            <span>Quick model</span>
            <input type="text" value={model} onChange={(e) => setModel(e.target.value)} />
          </label>
          <label>
            <span>Model that works problems out</span>
            <input type="text" value={solverModel} onChange={(e) => setSolverModel(e.target.value)} />
          </label>
        </div>
      )}
    </section>
  );
}

// ---------------- classes ----------------

function readFile(f: File): Promise<{ name: string; mimeType: string; data: string }> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onerror = () => rej(new Error('Could not read that file.'));
    r.onload = () => {
      const url = String(r.result);
      res({ name: f.name, mimeType: f.type || (f.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg'), data: url.slice(url.indexOf(',') + 1) });
    };
    r.readAsDataURL(f);
  });
}

const splitList = (text: string) =>
  text
    .split(/[\n,;•]+/)
    .map((t) => t.replace(/^\s*[-*\d.)]+\s*/, '').trim())
    .filter((t) => t.length > 1);

function Spine({ c, open, onOpen }: { c: ClassInfo; open: boolean; onOpen: () => void }) {
  // Taller spines for classes with more topics, so the shelf looks lived in.
  const h = 132 + Math.min(36, c.topics.length * 2);
  return (
    <button type="button" className={`spine ${open ? 'open' : ''}`} style={{ ['--spine' as string]: c.color, height: h }} onClick={onOpen} aria-pressed={open} title={`${c.name}: ${c.topics.length} topics`}>
      <span className="band top" />
      <span className="spine-name">{c.name}</span>
      <span className="spine-count">{c.topics.length}</span>
      <span className="band bottom" />
    </button>
  );
}

function ClassBook({ c, onSaved, onDelete, onSay }: { c: ClassInfo; onSaved: (v: SettingsView) => void; onDelete: () => void; onSay: (s: Say | null) => void }) {
  const [local, setLocalState] = useState<ClassInfo>(c);
  // The latest edit, so a delayed save always sends what is on screen now, never an older copy.
  const latest = useRef(c);
  const setLocal = (next: ClassInfo) => {
    latest.current = next;
    setLocalState(next);
  };
  const [draft, setDraft] = useState('');
  const [paste, setPaste] = useState<string | null>(null);
  const [kw, setKw] = useState('');
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [reading, setReading] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  // Only when a different class is opened, not on every save coming back.
  useEffect(() => {
    void persist.flush();
    setLocal(c);
    setFresh(new Set());
    setConfirm(false);
    setError(null);
    setSaved('idle');
  }, [c.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const persist = useDebounced(async () => {
    onSaved(await classesApi.save(latest.current));
    setSaved('saved');
  }, 450);
  const change = (patch: Partial<ClassInfo>) => {
    setLocal({ ...latest.current, ...patch });
    setSaved('saving');
    persist.schedule();
  };

  const addTopics = (list: string[]) => {
    const have = new Set(latest.current.topics.map((t) => t.toLowerCase()));
    const add = list.filter((t) => t && !have.has(t.toLowerCase()) && have.add(t.toLowerCase()));
    if (add.length) change({ topics: [...latest.current.topics, ...add] });
  };
  const onTopicKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === ',') && draft.trim()) {
      e.preventDefault();
      addTopics([draft.trim()]);
      setDraft('');
    } else if (e.key === 'Backspace' && !draft && local.topics.length) {
      change({ topics: local.topics.slice(0, -1) });
    }
  };

  const syllabus = async (f: File) => {
    setError(null);
    setReading(f.name);
    onSay({ mood: 'think', text: `Reading ${f.name}…` });
    try {
      // Save what was just typed first, so the syllabus's topics are added to it and nothing typed is lost.
      await persist.flush();
      const data = await readFile(f);
      const r = await classesApi.readSyllabus({ classId: local.id, text: '', upTo: latest.current.coveredUpTo, file: data });
      if (r.error) {
        setError(r.error);
        onSay({ mood: 'worry', text: r.error });
      } else if (r.view) {
        const before = new Set(latest.current.topics.map((t) => t.toLowerCase()));
        const updated = r.view.classes.find((x) => x.id === local.id);
        if (updated) setLocal(updated);
        onSaved(r.view);
        const added = (r.found ?? []).filter((t) => !before.has(t.toLowerCase()));
        setFresh(new Set(added.map((t) => t.toLowerCase())));
        onSay({ mood: 'cheer', text: added.length ? `Found ${added.length} new topic${added.length === 1 ? '' : 's'} in your syllabus!` : 'Read it. You already had all those topics.' });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReading(null);
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void syllabus(f);
  };

  return (
    <div className="open-book" style={{ ['--spine' as string]: local.color }}>
      <div className="book-page left">
        <div className="page-top">
          <input className="class-name" value={local.name} onChange={(e) => change({ name: e.target.value })} aria-label="Class name" maxLength={40} />
          <span className={`save-state ${saved}`}>{saved === 'saving' ? 'Saving…' : saved === 'saved' ? 'Saved ✓' : ''}</span>
        </div>
        <div className="swatches" role="radiogroup" aria-label="Colour">
          {CLASS_COLORS.map((col) => (
            <button key={col} type="button" role="radio" aria-checked={local.color === col} className={local.color === col ? 'on' : ''} style={{ background: col }} onClick={() => change({ color: col })} aria-label={`Colour ${col}`} />
          ))}
        </div>
        <label className="field">
          <span>How far has the class got?</span>
          <input value={local.coveredUpTo} placeholder='e.g. "week 6" or "up to chapter 4"' onChange={(e) => change({ coveredUpTo: e.target.value })} maxLength={80} />
        </label>
        <div className="field">
          <span>Notes titled with these words use this class</span>
          <div className="chips small">
            <span className="chip fixed">{local.name || 'name'}</span>
            {local.keywords.map((k) => (
              <span key={k} className="chip">
                {k}
                <button type="button" onClick={() => change({ keywords: local.keywords.filter((x) => x !== k) })} aria-label={`Remove ${k}`}>
                  ×
                </button>
              </span>
            ))}
            <input
              className="chip-input"
              value={kw}
              placeholder="+ word"
              aria-label="Add a word"
              onChange={(e) => setKw(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && kw.trim()) {
                  e.preventDefault();
                  if (!local.keywords.some((x) => x.toLowerCase() === kw.trim().toLowerCase())) change({ keywords: [...local.keywords, kw.trim()] });
                  setKw('');
                }
              }}
            />
          </div>
          <em className="hint">With Auto on, a notes window called "{local.name || 'Calc I'} - OneNote" picks this class by itself.</em>
        </div>
        <div className="danger">
          {confirm ? (
            <>
              <span>Remove {local.name}?</span>
              <button type="button" className="danger-btn" onClick={onDelete}>
                Yes, remove
              </button>
              <button type="button" className="link-btn" onClick={() => setConfirm(false)}>
                Keep it
              </button>
            </>
          ) : (
            <button type="button" className="link-btn muted" onClick={() => setConfirm(true)}>
              Remove this class
            </button>
          )}
        </div>
      </div>

      <div className="book-page right">
        <div className="page-top">
          <h3>Topics covered</h3>
          <span className="count">{local.topics.length}</span>
        </div>
        <div className="chips topics" onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}>
          {local.topics.map((t) => (
            <span key={t} className={`chip topic ${fresh.has(t.toLowerCase()) ? 'fresh' : ''}`}>
              {t}
              <button type="button" onClick={() => change({ topics: local.topics.filter((x) => x !== t) })} aria-label={`Remove ${t}`}>
                ×
              </button>
            </span>
          ))}
          <input className="chip-input" value={draft} placeholder={local.topics.length ? 'Add a topic…' : 'Type a topic and press Enter'} onChange={(e) => setDraft(e.target.value)} onKeyDown={onTopicKey} aria-label="Add a topic" />
        </div>
        {paste === null ? (
          <button type="button" className="link-btn" onClick={() => setPaste('')}>
            Paste a whole list
          </button>
        ) : (
          <div className="paste-box">
            <textarea rows={4} value={paste} autoFocus placeholder={'limits\nchain rule\nrelated rates'} onChange={(e) => setPaste(e.target.value)} aria-label="A list of topics" />
            <div className="row">
              <button
                type="button"
                className="ghost-btn"
                onClick={() => {
                  addTopics(splitList(paste));
                  setPaste(null);
                }}
              >
                Add these
              </button>
              <button type="button" className="link-btn" onClick={() => setPaste(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        <div
          className={`dropzone ${drag ? 'drag' : ''} ${reading ? 'reading' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
          onClick={() => !reading && file.current?.click()}
          role="button"
          tabIndex={0}
          aria-label="Add topics from a syllabus file"
          onKeyDown={(e) => e.key === 'Enter' && file.current?.click()}
        >
          {reading ? (
            <>
              <span className="scan" />
              <strong>Reading {reading}…</strong>
              <em>Pulling out the topics</em>
            </>
          ) : (
            <>
              <strong>Drop your syllabus here</strong>
              <em>PDF or a photo · or click to choose · its topics are added to this class</em>
            </>
          )}
          <input
            ref={file}
            type="file"
            accept=".pdf,image/png,image/jpeg,image/webp"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void syllabus(f);
              e.target.value = '';
            }}
          />
        </div>
        {error && <p className="error-line">{error}</p>}
      </div>
    </div>
  );
}

function Classes({ view, onView, onSay }: { view: SettingsView; onView: (v: SettingsView) => void; onSay: (s: Say | null) => void }) {
  const [open, setOpen] = useState<string | null>(view.classes[0]?.id ?? null);
  const [naming, setNaming] = useState<string | null>(null);
  const current = view.classes.find((c) => c.id === open) ?? null;

  const add = async () => {
    const name = naming?.trim();
    if (!name) return;
    const r = await classesApi.add(name);
    onView(r.view);
    setOpen(r.id);
    setNaming(null);
    onSay({ mood: 'happy', text: `${name} is on the shelf. Add its topics, or drop the syllabus in.` });
  };
  const choose = async (id: ActiveClass) => onView(await classesApi.setActive(id));

  return (
    <section id="classes" className="page-section">
      <SectionHead step="Step 2 · optional" title="Your classes" sub="Save what each class has covered. tanrushu only points you to methods from those topics, never to something your class hasn't reached yet." />

      <div className="shelf-wrap">
        <div className="shelf">
          {view.classes.map((c) => (
            <Spine key={c.id} c={c} open={c.id === open} onOpen={() => setOpen(c.id)} />
          ))}
          {naming === null ? (
            <button type="button" className="spine add" onClick={() => setNaming('')} title="Add a class">
              <span className="plus">+</span>
              <span className="spine-name">Add a class</span>
            </button>
          ) : (
            <form
              className="new-class"
              onSubmit={(e) => {
                e.preventDefault();
                void add();
              }}
            >
              <input autoFocus value={naming} placeholder="Class name, e.g. Calc I" maxLength={40} aria-label="New class name" onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setNaming(null)} />
              <button type="submit" className="chunky small" disabled={!naming.trim()}>
                Add
              </button>
            </form>
          )}
        </div>
        <div className="plank" />
      </div>

      {view.classes.length > 0 && (
        <div className="follows">
          <span>tanrushu follows</span>
          <div className="segmented" role="radiogroup" aria-label="Which class tanrushu follows">
            {[{ id: 'auto', name: 'Auto', color: '' }, ...view.classes, { id: 'none', name: 'No class', color: '' }].map((c) => (
              <button key={c.id} type="button" role="radio" aria-checked={view.activeClass === c.id} className={view.activeClass === c.id ? 'on' : ''} onClick={() => void choose(c.id)}>
                {c.color && <i style={{ background: c.color }} />}
                {c.name}
              </button>
            ))}
          </div>
          <em className="hint">
            {view.activeClass === 'auto'
              ? 'Auto picks the class whose name is in your notes window title.'
              : view.activeClass === 'none'
                ? 'No limits: any method is fair game.'
                : "Always this class, whatever notes you have open. You can switch from tanrushu's ⋯ menu too."}
          </em>
        </div>
      )}

      {current ? (
        <ClassBook
          c={current}
          onSaved={onView}
          onSay={onSay}
          onDelete={async () => {
            const v = await classesApi.remove(current.id);
            onView(v);
            setOpen(v.classes[0]?.id ?? null);
          }}
        />
      ) : (
        <p className="empty-note">No classes yet. Add one, then type its topics or drop in the syllabus.</p>
      )}
    </section>
  );
}

// ---------------- the page ----------------

export function Settings() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [testing, setTesting] = useState(false);
  const [keysOk, setKeysOk] = useState<boolean | null>(null);
  const [said, setSaid] = useState<Say | null>(null);
  const [section, setSection] = useState<SectionId>('keys');
  const main = useRef<HTMLElement>(null);

  useEffect(() => {
    void api.get().then(setView);
    return api.onChanged(setView);
  }, []);

  // Which section is on screen, for the sidebar.
  const loaded = view !== null;
  useEffect(() => {
    const el = main.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setSection(top.target.id as SectionId);
      },
      { root: el, rootMargin: '0px 0px -60% 0px' },
    );
    el.querySelectorAll('section[id]').forEach((s) => io.observe(s));
    return () => io.disconnect();
  }, [loaded]);

  // A remark from tanrushu fades after a while.
  useEffect(() => {
    if (!said) return;
    const t = setTimeout(() => setSaid(null), 7000);
    return () => clearTimeout(t);
  }, [said]);

  const steps = useMemo(() => {
    if (!view) return [];
    const custom = view.sprite.mode === 'custom';
    return [
      { id: 'keys' as const, label: 'Keys', done: view.gemini.saved && keysOk !== false, note: view.gemini.saved ? (view.serp.saved ? 'Both saved' : 'Gemini saved') : 'Needed' },
      { id: 'classes' as const, label: 'Classes', done: view.classes.length > 0, note: view.classes.length ? `${view.classes.length} on the shelf` : 'Optional' },
      { id: 'sprite' as const, label: 'Sprite', done: custom, note: custom ? view.sprite.name || 'Your picture' : 'tanrushu' },
      { id: 'options' as const, label: 'Options', done: true, note: view.showEverywhere ? 'Every app' : 'Notes apps only' },
    ];
  }, [view, keysOk]);

  if (!view) return null;

  const ready = view.gemini.saved && keysOk !== false;
  const say: Say =
    said ??
    (testing
      ? { mood: 'think', text: 'Testing your keys…' }
      : !view.gemini.saved
        ? { mood: 'worry', text: "Paste a Gemini key and I'll wake up!" }
        : keysOk === false
          ? { mood: 'worry', text: "That key didn't work. Check it on the card." }
          : !view.serp.saved
            ? { mood: 'happy', text: 'Add a SerpApi key and I can find you videos too.' }
            : view.classes.length === 0
              ? { mood: 'happy', text: "Add your classes so I only use what you've learned." }
              : { mood: 'happy', text: 'All set! Open your notes and call me.' });
  const done = steps.filter((s) => s.done).length;

  return (
    <div className="setup">
      <aside className="rail">
        <div className="rail-brand">
          <BookLogo size={34} />
          <div>
            <strong>
              myTA<span>.tech</span>
            </strong>
            <em>Setup</em>
          </div>
        </div>

        <div className="buddy">
          <div className="buddy-bubble" key={say.text} role="status">
            {say.text}
          </div>
          <Shadow className="buddy-stage" extraCss=".stage{display:flex;justify-content:center;padding-top:4px}">
            <div className="stage">
              <Avatar mood={say.mood} sprite={view.sprite} mirror={false} />
            </div>
          </Shadow>
        </div>

        <nav className="steps" aria-label="Setup sections">
          {steps.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`step ${s.done ? 'done' : ''} ${section === s.id ? 'here' : ''}`}
              onClick={() => document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            >
              <span className="tick">{s.done ? '✓' : ''}</span>
              <span className="step-text">
                <strong>{s.label}</strong>
                <em>{s.note}</em>
              </span>
            </button>
          ))}
        </nav>

        <div className="progress" aria-label={`${done} of ${steps.length} done`}>
          {steps.map((s) => (
            <i key={s.id} className={s.done ? 'on' : ''} />
          ))}
        </div>
        <p className="rail-foot">
          {ready ? (
            <>
              Call tanrushu with <kbd>{view.hotkey}</kbd>
            </>
          ) : (
            'Add your Gemini key to start'
          )}
        </p>
      </aside>

      <main ref={main} className="sheet">
        <Keys
          view={view}
          onView={setView}
          onBusy={(b, ok) => {
            setTesting(b);
            if (!b && ok !== undefined) {
              setKeysOk(ok);
              if (ok) setSaid({ mood: 'cheer', text: "Your keys work. Let's study!" });
            }
          }}
        />
        <Classes view={view} onView={setView} onSay={setSaid} />

        <section id="sprite" className="page-section">
          <SectionHead step="Step 3 · optional" title="Make it yours" sub="tanrushu is a pixel monkey until you give it a face: your TA, a pet, a friend. Photos are turned into a sprite on this computer and never uploaded." />
          <SpriteStudio
            sprite={view.sprite}
            onSaved={(s: MySprite) => {
              setView({ ...view, sprite: s });
              setSaid({ mood: 'cheer', text: s.mode === 'custom' ? `Hi, I'm ${s.name || 'your new sprite'}!` : "I'm back to being tanrushu!" });
            }}
          />
        </section>

        <section id="options" className="page-section">
          <SectionHead step="Step 4" title="Options" sub="Where tanrushu shows up, and what it stays out of." />
          <div className="option-list">
            <Switch
              on={view.showEverywhere}
              onChange={(v) => void api.showEverywhere(v).then(setView)}
              label="Show tanrushu in every app"
              hint="Off: only in note-taking, whiteboard, document and PDF apps (OneNote, Notion, Paint, Word, a .pdf…). You can still call it anywhere with the hotkey."
            />
            <Switch
              on={view.hideFromCapture}
              onChange={(v) => void api.hideFromCapture(v).then(setView)}
              label="Keep tanrushu out of screenshots"
              hint="Recommended: it never reads its own speech bubble by mistake, and it won't show up in your screen recordings."
            />
          </div>
          <div className="hotkey-card">
            <kbd>{view.hotkey}</kbd>
            <span>calls tanrushu from anywhere. It also lives in the taskbar tray: right-click the brown book.</span>
          </div>
        </section>
      </main>
    </div>
  );
}
