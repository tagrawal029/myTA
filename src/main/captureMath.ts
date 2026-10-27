import type { Box } from '../core/shared/types';
import type { PhysRect } from './win32';

/** The part of `rect` that is on the display, in the display picture's own pixels (`scale` = picture pixels per screen pixel). */
export function cropRect(rect: PhysRect, display: PhysRect, scale: number): PhysRect | null {
  const x0 = Math.max(rect.x, display.x);
  const y0 = Math.max(rect.y, display.y);
  const x1 = Math.min(rect.x + rect.width, display.x + display.width);
  const y1 = Math.min(rect.y + rect.height, display.y + display.height);
  if (x1 - x0 < 50 || y1 - y0 < 50) return null;
  return { x: Math.round((x0 - display.x) * scale), y: Math.round((y0 - display.y) * scale), width: Math.round((x1 - x0) * scale), height: Math.round((y1 - y0) * scale) };
}

/**
 * The part of the shot around a box, with room around it (the first box may be a line off). It is at least a fifth of the width and a
 * sixth of the height, so there is always enough around the piece to find it in.
 */
export function closeUpRegion(box: Box): Box {
  const [y0, x0, y1, x1] = box;
  const h = Math.min(1000, Math.max(170, (y1 - y0) * 3));
  const w = Math.min(1000, Math.max(200, (x1 - x0) * 2));
  const top = Math.round(Math.min(1000 - h, Math.max(0, (y0 + y1) / 2 - h / 2)));
  const left = Math.round(Math.min(1000 - w, Math.max(0, (x0 + x1) / 2 - w / 2)));
  return [top, left, Math.round(top + h), Math.round(left + w)];
}

/** Maps a box found in a close-up back onto the whole shot. */
export function fromCloseUp(inner: Box, region: Box): Box {
  const [ry0, rx0, ry1, rx1] = region;
  const h = ry1 - ry0;
  const w = rx1 - rx0;
  return [Math.round(ry0 + (inner[0] / 1000) * h), Math.round(rx0 + (inner[1] / 1000) * w), Math.round(ry0 + (inner[2] / 1000) * h), Math.round(rx0 + (inner[3] / 1000) * w)];
}
