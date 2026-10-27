// Pictures of the work window. Electron captures the whole display the window is on (myTA's own overlay is left out of every capture by
// content protection, so the monkey and the red box never end up in what the model reads), and the window's rectangle is cut out of it.
// A read gets a sharp JPEG; a watch tick only needs a tiny grayscale thumbnail to see whether anything changed.
import { desktopCapturer, nativeImage, screen, type NativeImage, type Rectangle } from 'electron';
import { readFileSync } from 'node:fs';
import { closeUpRegion, cropRect } from './captureMath';
import type { Box } from '../core/shared/types';
import type { Thumb } from './gate';
import type { PhysRect, WinInfo } from './win32';

export interface Shot {
  /** Base64 JPEG (reads only; "" for ticks). */
  jpeg: string;
  width: number;
  height: number;
  /** The window it was taken of, and where that window was on screen in DIPs at the time. */
  win: WinInfo;
  rectDip: Rectangle;
  /**
   * The small grayscale picture the watch compares, always made the way a tick makes it (a read's too), so a read's picture and the
   * next tick's match when nothing changed. Made from the full-size capture, small text comes out different enough to look like new work.
   */
  thumb: Thumb;
  at: number;
}

export interface ScreenSource {
  shot(win: WinInfo, mode: 'read' | 'tick'): Promise<Shot | null>;
  /** A close-up of part of a read shot, for placing the red square precisely. Optional: without it the first box is used. */
  zoom?(shot: Shot, box: Box): Promise<CloseUp | null>;
  toDip(rect: PhysRect): Rectangle;
}

export const THUMB_W = 160;
export const THUMB_H = 120;
const MAX_READ_WIDTH = 1600;

/** Grayscale, fixed size, from a BGRA bitmap. */
export function grayThumb(img: NativeImage): Thumb {
  const small = img.resize({ width: THUMB_W, height: THUMB_H, quality: 'good' });
  const bgra = small.toBitmap();
  const out = new Uint8Array(THUMB_W * THUMB_H);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(0.114 * bgra[i * 4] + 0.587 * bgra[i * 4 + 1] + 0.299 * bgra[i * 4 + 2]);
  return out;
}

/** A close-up of a shot: the JPEG, and which part of the shot it shows (0..1000 of the shot, like a box). */
export interface CloseUp {
  jpeg: string;
  region: Box;
}

/** Cuts the close-up out of a shot's JPEG and enlarges it to about 1200 px wide, so small writing is big. */
export async function zoomShot(shot: Shot, box: Box): Promise<CloseUp | null> {
  if (!shot.jpeg) return null;
  const img = nativeImage.createFromBuffer(Buffer.from(shot.jpeg, 'base64'));
  const { width, height } = img.getSize();
  if (!width || !height) return null;
  const region = closeUpRegion(box);
  const rect = {
    x: Math.round((region[1] / 1000) * width),
    y: Math.round((region[0] / 1000) * height),
    width: Math.max(1, Math.round(((region[3] - region[1]) / 1000) * width)),
    height: Math.max(1, Math.round(((region[2] - region[0]) / 1000) * height)),
  };
  const part = img.crop(rect);
  const scale = Math.min(4, 1200 / rect.width);
  const big = scale > 1 ? part.resize({ width: Math.round(rect.width * scale), height: Math.round(rect.height * scale), quality: 'best' }) : part;
  return { jpeg: big.toJPEG(90).toString('base64'), region };
}

/** The JPEG the model reads: no wider than 1600 px. */
export function readJpeg(img: NativeImage): { jpeg: string; width: number; height: number } {
  const { width, height } = img.getSize();
  const scaled = width > MAX_READ_WIDTH ? img.resize({ width: MAX_READ_WIDTH, height: Math.round((height * MAX_READ_WIDTH) / width), quality: 'best' }) : img;
  const s = scaled.getSize();
  return { jpeg: scaled.toJPEG(82).toString('base64'), width: s.width, height: s.height };
}

export const realScreen: ScreenSource = {
  zoom: zoomShot,
  toDip(rect) {
    return process.platform === 'win32' ? screen.screenToDipRect(null, rect) : rect;
  },
  async shot(win, mode) {
    const dip = this.toDip(win.rect);
    const display = screen.getDisplayMatching(dip);
    const phys = process.platform === 'win32' ? screen.dipToScreenRect(null, display.bounds) : display.bounds;
    const shrink = mode === 'tick' ? 4 : 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(phys.width / shrink), height: Math.round(phys.height / shrink) },
      fetchWindowIcons: false,
    });
    const src = sources.find((s) => s.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : null);
    if (!src || src.thumbnail.isEmpty()) return null;
    const img = src.thumbnail;
    const k = img.getSize().width / phys.width;
    const crop = cropRect(win.rect, phys, k);
    if (!crop) return null;
    const part = img.crop(crop);
    // Where the captured part is on screen (a window hanging off the edge of the display is cut at the edge), so a box drawn on the
    // picture lands on the same spot of the real window.
    const rectDip = this.toDip({ x: Math.round(phys.x + crop.x / k), y: Math.round(phys.y + crop.y / k), width: Math.round(crop.width / k), height: Math.round(crop.height / k) });
    if (mode === 'tick') return { jpeg: '', width: 0, height: 0, win, rectDip, thumb: grayThumb(part), at: Date.now() };
    const tick = await this.shot(win, 'tick').catch(() => null);
    return { ...readJpeg(part), win, rectDip, thumb: tick?.thumb ?? grayThumb(part), at: Date.now() };
  },
};

/**
 * For the end-to-end test: the "work window" is a picture file the test swaps between steps, shown at a fixed place on screen.
 * Nothing on the real screen is captured.
 */
export function fileScreen(pathOf: () => string, rect: Rectangle): ScreenSource {
  return {
    toDip: (r) => r,
    zoom: zoomShot,
    async shot(win, mode) {
      const img = nativeImage.createFromBuffer(readFileSync(pathOf()));
      const thumb = grayThumb(img);
      if (mode === 'tick') return { jpeg: '', width: 0, height: 0, win, rectDip: rect, thumb, at: Date.now() };
      return { ...readJpeg(img), win, rectDip: rect, thumb, at: Date.now() };
    },
  };
}
