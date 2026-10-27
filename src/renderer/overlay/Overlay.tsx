// tanrushu's own window: the monkey (or the student's own sprite), its options, and its speech bubble. The window is exactly as big as
// what's in it, so every click, tap, double-tap or pen tap on it lands on tanrushu, and everything around it stays the app underneath.
// The red square lives in a separate see-through window (marks) that never takes a click.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Bubble, BubbleAction, MySprite, UiState } from '../../core/shared/ui';
import { DEFAULT_SPRITE } from '../../core/shared/ui';
import type { ClassesBrief } from '../../preload/index';
import { Avatar } from '../shared/sprite/Avatar';
import { PixelIcon } from '../shared/sprite/pixelIcons';
import { readable } from '../../core/shared/readableMath';

const api = window.myta.overlay;

type IconName = 'bulb' | 'alert' | 'star' | 'check' | 'play' | 'eye' | 'copy' | 'book' | 'x' | 'more' | 'film' | 'moon' | 'upload' | 'refresh';
const ICON_PATHS: Record<IconName, string> = {
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2v.1h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z',
  alert: 'M12 8v5M12 17h.01M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  star: 'M12 2.8l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.6l-5.8 3.1 1.1-6.5L2.6 9.6l6.5-.9z',
  check: 'M9 11l3 3 8-8M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8',
  play: 'M7 4.5v15l13-7.5z',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14zM20 17v4H6.5A2.5 2.5 0 0 1 4 18.5',
  x: 'M6 6l12 12M18 6 6 18',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  film: 'M4 5h16v14H4zM8 5v14M16 5v14M4 9h4M4 15h4M16 9h4M16 15h4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
};
function Icon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" fill={name === 'play' || name === 'star' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={name === 'more' ? 3.4 : 2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

const KIND_ICON: Record<Bubble['kind'], IconName> = { hello: 'star', hint: 'bulb', mistake: 'alert', copy: 'copy', cheer: 'star', check: 'check', info: 'eye', error: 'alert', video: 'film', fixed: 'check' };
const KIND_CLASS: Partial<Record<Bubble['kind'], string>> = { mistake: 'kind-mistake', copy: 'kind-mistake', error: 'kind-mistake', cheer: 'kind-cheer', hello: 'kind-hello', fixed: 'kind-hello', check: 'kind-check-work' };

function VideoCardView({ v, onWatch, fmt }: { v: NonNullable<Bubble['video']>; onWatch: () => void; fmt: (t: string) => string }) {
  return (
    <div className="clip">
      <button className="thumb" onClick={onWatch} aria-label={`Watch ${v.title} from ${v.at}`}>
        <img src={`https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`} alt="" />
        <span className="play">
          <Icon name="play" />
        </span>
        <span className="stamp">{v.refining ? 'finding the minute…' : `starts ${v.at}`}</span>
      </button>
      <div className="info">
        <p className="why">{fmt(v.why)}</p>
        <p className="meta">
          {fmt(v.title)} · {v.channel}
        </p>
      </div>
    </div>
  );
}

function BubbleView({ b, onAct, onClose, fmt }: { b: Bubble; onAct: (id: BubbleAction, arg?: string) => void; onClose: () => void; fmt: (t: string) => string }) {
  return (
    <div className="card" role="status" aria-live="polite">
      <div className="fx">
        <i className="bar" />
        {!b.pending && <i className="shine" />}
      </div>
      <div className="head">
        <span className="icon-chip">
          <Icon name={KIND_ICON[b.kind]} />
        </span>
        <p className="title">{fmt(b.title)}</p>
        <button className="x" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      {b.pending ? (
        <div className="shimmer" aria-label="Thinking">
          <i />
          <i />
          <i />
        </div>
      ) : (
        <>
          {b.quote && (
            <p className="quote">
              <span>Your work</span>
              <code>{fmt(b.quote)}</code>
            </p>
          )}
          {b.text && <p className="msg">{fmt(b.text)}</p>}
        </>
      )}
      {b.video && !b.pending && <VideoCardView v={b.video} onWatch={() => onAct('watch')} fmt={fmt} />}
      {!b.pending && b.actions.length > 0 && (
        <div className="row">
          {b.actions.map((a, i) => (
            <button key={`${a.id}-${i}`} className={`b ${i === 0 ? 'primary' : ''}`} onClick={() => onAct(a.id, a.arg)}>
              {fmt(a.label)}
            </button>
          ))}
        </div>
      )}
      <span className="nub" />
    </div>
  );
}

const PHASE_LINE: Record<UiState['phase'], string> = {
  asleep: 'Napping · tap me',
  idle: 'Ready',
  reading: 'Reading the problem…',
  choosing: 'Which question? Tap one',
  watching: 'Watching',
  noProblem: 'No problem on screen yet',
};

export function Overlay() {
  const [s, setS] = useState<UiState | null>(null);
  const [sprite, setSprite] = useState<MySprite>(DEFAULT_SPRITE);
  const [side, setSide] = useState<'left' | 'right'>('left');
  const [menu, setMenu] = useState(false);
  const [classes, setClasses] = useState<ClassesBrief>({ list: [], active: 'auto', inUse: null });
  const [entering, setEntering] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const stack = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.get().then((r) => {
      setS(r.state);
      setSprite(r.sprite);
      setClasses(r.classes);
      setSide(r.side);
    });
    const offs = [api.onState(setS), api.onSprite(setSprite), api.onClasses(setClasses), api.onSide(setSide)];
    return () => offs.forEach((f) => f());
  }, []);

  // The window is sized to what's in it: tell the main process whenever that changes (a bubble opens, the menu opens…).
  useLayoutEffect(() => {
    const el = wrap.current;
    const st = stack.current;
    if (!el || !st) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      const sr = st.getBoundingClientRect();
      api.size({ w: Math.ceil(r.width), h: Math.ceil(r.height), stackLeft: Math.round(sr.left - r.left), stackWidth: Math.ceil(sr.width) });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    ro.observe(st);
    return () => ro.disconnect();
  });

  // A little hop when it starts reading.
  const phase = s?.phase;
  useEffect(() => {
    if (phase === 'reading') {
      setEntering(true);
      const t = setTimeout(() => setEntering(false), 800);
      return () => clearTimeout(t);
    }
  }, [phase]);

  const act = useCallback(
    (type: string, arg?: string) => {
      setMenu(false);
      if (type === 'watch') api.act({ type: 'watch', url: s?.bubble?.video?.url ?? '' });
      else if (type === 'videoFor') api.act({ type: 'video', concept: arg });
      else api.act({ type, arg });
    },
    [s],
  );

  // Drag the monkey anywhere (the whole window moves); a click or tap without a drag says hello.
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const onDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.screenX, y: e.screenY, moved: false };
  };
  const onMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.screenX - d.x;
    const dy = e.screenY - d.y;
    // A finger or pen wobbles a little on a tap: only a real move is a drag.
    if (!d.moved && Math.hypot(dx, dy) < (e.pointerType === 'mouse' ? 5 : 12)) return;
    d.moved = true;
    api.drag({ dx, dy, end: false });
  };
  const onUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) api.drag({ dx: e.screenX - d.x, dy: e.screenY - d.y, end: true });
    else api.act({ type: 'call' });
  };

  if (!s) return null;
  const spriteName = (sprite.mode === 'custom' && sprite.name) || 'tanrushu';
  const busy = s.busy;
  const kindClass = s.bubble ? (KIND_CLASS[s.bubble.kind] ?? '') : '';
  // Math the way it is read (Ω, x², √), except on a code problem, where every symbol means what it says.
  const fmt = (t: string) => (s.code ? t : readable(t));
  const line = !s.hasKeys ? 'Add your Gemini key in Setup' : s.phase === 'watching' ? `Watching ${s.watching || 'your work'}` : PHASE_LINE[s.phase];

  return (
    <div className={`root ${kindClass}`}>
      <div ref={wrap} className={`dock-wrap side-${side}`}>
        {s.bubble && <BubbleView b={s.bubble} onAct={act} onClose={() => api.act({ type: 'dismissBubble' })} fmt={fmt} />}
        <div ref={stack} className="stack">
          <p className={`status-line ${!s.hasKeys ? 'warn' : ''}`} onClick={() => !s.hasKeys && act('setup')}>
            <span className={`dot ${s.hasKeys ? s.phase : 'noProblem'}`} />
            {line}
            {s.phase === 'watching' && s.problem && <span className="problem-tag">{fmt(s.problem)}</span>}
            {/* Reading is automatic; this is only for when it picked the wrong problem, or missed one. */}
            {s.hasKeys && (s.phase === 'watching' || s.phase === 'noProblem') && (
              <button className="reread" onClick={() => act('readScreen')} title="Read the problem on my screen again">
                {s.source === 'upload' || s.source === 'photo' ? 'Read my screen' : s.phase === 'watching' ? 'Wrong problem?' : 'Look again'}
              </button>
            )}
            {classes.inUse && (
              <span className="class-tag" title="The class tanrushu is following">
                <i style={{ background: classes.inUse.color }} />
                {classes.inUse.name}
              </span>
            )}
            {s.solvedToday > 0 && (
              <span className="solved" title="Solved today">
                <PixelIcon name="banana" scale={2} /> {s.solvedToday}
              </span>
            )}
          </p>
          <button
            className="char"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={() => (drag.current = null)}
            aria-label={s.phase === 'asleep' ? `${spriteName}, napping (tap to wake)` : `${spriteName} (tap to say hi, drag to move)`}
            title={s.phase === 'asleep' ? 'Tap to wake me' : 'Tap to say hi, drag to move'}
          >
            <Avatar mood={busy === 'solve' || busy === 'hint' || busy === 'video' || busy === 'check' ? 'think' : s.mood} sprite={sprite} entering={entering} />
            {s.phase === 'asleep' && (
              <span className="zzz">
                <PixelIcon name="zzz" scale={2} />
              </span>
            )}
          </button>
          {menu && (
            <div className="menu" role="menu">
              <button role="menuitem" onClick={() => act('problem')}>
                <Icon name="upload" /> Upload or snap the problem
              </button>
              {classes.list.length > 0 && (
                <div className="menu-classes" role="group" aria-label="Class">
                  <p className="menu-label">Class</p>
                  {[{ id: 'auto', name: classes.active === 'auto' && classes.inUse ? `Auto (${classes.inUse.name})` : 'Auto: match my notes', color: '' }, ...classes.list, { id: 'none', name: 'No class', color: '' }].map((c) => (
                    <button
                      key={c.id}
                      role="menuitemradio"
                      aria-checked={classes.active === c.id}
                      className={classes.active === c.id ? 'on' : ''}
                      onClick={() => {
                        api.setClass(c.id);
                        setMenu(false);
                      }}
                    >
                      <i className="swatch" style={{ background: c.color || 'transparent' }} />
                      {c.name}
                    </button>
                  ))}
                </div>
              )}
              <button role="menuitem" onClick={() => act('setup')}>
                <Icon name="book" /> Setup and classes
              </button>
              <button role="menuitem" onClick={() => act(s.phase === 'asleep' ? 'call' : 'sleep')}>
                <Icon name="moon" /> {s.phase === 'asleep' ? 'Wake up' : 'Take a nap'}
              </button>
            </div>
          )}
          <div className="tools">
            <button className="tool" onClick={() => act('hint')} title="Point me in the right direction">
              <Icon name="bulb" />
              <span>Hint</span>
            </button>
            <button className="tool" onClick={() => act('video')} title="A short video on this">
              <Icon name="film" />
              <span>Video</span>
            </button>
            <button className={`tool more ${menu ? 'on' : ''}`} onClick={() => setMenu((m) => !m)} aria-label="More" aria-expanded={menu}>
              <Icon name="more" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
