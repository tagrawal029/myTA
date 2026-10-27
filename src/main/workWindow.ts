// Which window is "the work": the last window the student was in that isn't myTA itself or a piece of Windows (the taskbar, the
// desktop, the Start menu). Clicking the monkey makes myTA's own window the foreground one for a moment, so the work window is the one
// in front just BEFORE that.
import type { WinInfo } from './win32';

/** Window classes that are part of Windows, not something the student works in. */
const SHELL_CLASSES = new Set([
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
  'Progman',
  'WorkerW',
  'Windows.UI.Core.CoreWindow',
  'TaskManagerWindow',
  'ForegroundStaging',
  'MultitaskingViewFrame',
  'XamlExplorerHostIslandWindow',
  'TopLevelWindowForOverflowXamlIsland',
  'NotifyIconOverflowWindow',
  '#32768',
]);

/** True if this window can be the student's work: visible, a real size, not minimized, not myTA, not part of the Windows shell. */
export function isWorkCandidate(w: WinInfo | null, ownPids: ReadonlySet<number>): w is WinInfo {
  if (!w || w.minimized) return false;
  if (ownPids.has(w.pid)) return false;
  if (SHELL_CLASSES.has(w.cls)) return false;
  return w.rect.width >= 200 && w.rect.height >= 150;
}

export class WorkWindowTracker {
  private last: WinInfo | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** The window really in front right now (the desktop, the taskbar, a minimized app's frame…), leaving out only myTA's own windows. */
  private front: WinInfo | null = null;

  constructor(
    private read: () => WinInfo | null,
    private ownPids: () => ReadonlySet<number>,
    private onChange?: (w: WinInfo) => void,
    /** Called whenever the window in front changes, whatever it is (so tanrushu can hide on the desktop or in another app). */
    private onFront?: (w: WinInfo | null) => void,
  ) {}

  /** Re-reads the foreground window; keeps the previous work window when the one in front isn't a candidate. */
  poll(): WinInfo | null {
    let w: WinInfo | null = null;
    try {
      w = this.read();
    } catch {
      /* a window that closed between calls */
    }
    // Clicking tanrushu or its windows puts myTA in front for a moment: that doesn't count as leaving the notes app.
    if (!w || !this.ownPids().has(w.pid)) {
      const changed = (this.front?.hwnd ?? 0) !== (w?.hwnd ?? 0) || this.front?.minimized !== w?.minimized || this.front?.title !== w?.title;
      this.front = w;
      if (changed) this.onFront?.(w);
    }
    if (isWorkCandidate(w, this.ownPids())) {
      const moved = !this.last || this.last.hwnd !== w.hwnd || !sameRect(this.last.rect, w.rect);
      this.last = w;
      if (moved) this.onChange?.(w);
    }
    return this.last;
  }

  current(): WinInfo | null {
    return this.last;
  }

  /** The window in front (not myTA's own), or null when there is none (the screen is locked). */
  inFront(): WinInfo | null {
    return this.front;
  }

  start(intervalMs = 400): void {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const sameRect = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
