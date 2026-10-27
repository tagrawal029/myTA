// Draws children in a shadow root with the sprite's own styles, so the character looks exactly as it does on screen and the page's styles
// can't touch it (and its styles can't touch the page).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { spriteCss } from './sprite/spriteCss';

export function Shadow({ children, className, extraCss = '' }: { children: ReactNode; className?: string; extraCss?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [mount, setMount] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!host.current) return;
    const root = host.current.shadowRoot ?? host.current.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `${spriteCss}\n:host{display:block}${extraCss}`;
    const m = document.createElement('div');
    m.className = 'root';
    root.append(style, m);
    setMount(m);
    return () => {
      style.remove();
      m.remove();
    };
  }, [extraCss]);
  return (
    <div ref={host} className={className}>
      {mount && createPortal(children, mount)}
    </div>
  );
}
