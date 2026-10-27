// The see-through layer over the whole screen: the red square on a slip, and the confetti when a problem is solved. The square's label
// has a × that closes it; that label and the square's thin frame are the only parts that take a click (everything else, inside the
// square too, goes through to the app underneath).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { UiState } from '../../core/shared/ui';
import { confettiBurst } from '../shared/sprite/confetti';

const api = window.myta.marks;
type Rect = { x: number; y: number; width: number; height: number };

export function Marks() {
  const [s, setS] = useState<UiState | null>(null);
  const dock = useRef<Rect | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const lastCheer = useRef<number | null>(null);

  useEffect(() => {
    void api.get().then((r) => {
      lastCheer.current = r.state.cheer;
      dock.current = r.dock;
      setS(r.state);
    });
    const offs = [api.onState(setS), api.onDock((d) => (dock.current = d))];
    return () => offs.forEach((f) => f());
  }, []);

  // Confetti once per solved problem, from tanrushu.
  useEffect(() => {
    if (!s || lastCheer.current === null || s.cheer === lastCheer.current) return;
    lastCheer.current = s.cheer;
    const d = dock.current;
    if (canvas.current) confettiBurst(canvas.current, { x: d ? d.x + d.width - 70 : window.innerWidth - 100, y: d ? d.y + d.height - 100 : window.innerHeight - 140 });
  }, [s]);

  const m = s?.mark;
  const tag = useRef<HTMLButtonElement>(null);
  // Tell the app which parts take clicks: the label, and a thin band along the square's edge (so the frame and its glow still show).
  useLayoutEffect(() => {
    if (!m) return api.hit(null);
    const send = () => {
      const t = tag.current?.getBoundingClientRect();
      const band = 7;
      const { x, y, width: w, height: h } = m;
      const frame = [
        { x: x - band, y: y - band, width: w + band * 2, height: band * 2 },
        { x: x - band, y: y + h - band, width: w + band * 2, height: band * 2 },
        { x: x - band, y: y - band, width: band * 2, height: h + band * 2 },
        { x: x + w - band, y: y - band, width: band * 2, height: h + band * 2 },
      ];
      api.hit(t ? [{ x: t.left - 2, y: t.top - 2, width: t.width + 4, height: t.height + 4 }, ...frame] : frame);
    };
    send();
    // The label pops in with an animation: send its final place once it has settled.
    const later = setTimeout(send, 600);
    return () => clearTimeout(later);
  }, [m?.x, m?.y, m?.width, m?.height, m?.id]);

  return (
    <div className="root">
      <canvas ref={canvas} className="confetti" />
      {m && (
        <div className="mark" style={{ left: m.x, top: m.y, width: m.width, height: m.height }}>
          <button ref={tag} className={`tag ${m.y < 40 ? 'below' : ''}`} onClick={() => api.close()} title="Close the square" aria-label={`${m.label}: close the square`}>
            {m.label}
            <span className="close" aria-hidden>
              ×
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
