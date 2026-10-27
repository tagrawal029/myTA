// The few Windows calls myTA needs to know which window the student is writing in: the foreground window, its title, class and process,
// and its exact on-screen rectangle (DWM's extended frame bounds, which leave out the invisible resize border GetWindowRect includes).
// Electron's main process is per-monitor DPI aware, so every rectangle here is in physical screen pixels.
import koffi from 'koffi';

export interface PhysRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WinInfo {
  hwnd: number;
  pid: number;
  title: string;
  cls: string;
  /** Physical pixels. */
  rect: PhysRect;
  minimized: boolean;
  /** The program's file name, lower case ("onenote.exe"), or "" when Windows won't say. */
  exe: string;
}

type Fn = (...args: unknown[]) => unknown;
let api: { fg: Fn; pid: Fn; rect: Fn; dwm: Fn; text: Fn; cls: Fn; iconic: Fn; open: Fn; image: Fn; close: Fn } | null = null;

function load() {
  if (api) return api;
  const user32 = koffi.load('user32.dll');
  const dwmapi = koffi.load('dwmapi.dll');
  const kernel32 = koffi.load('kernel32.dll');
  api = {
    open: kernel32.func('intptr_t __stdcall OpenProcess(uint32_t dwDesiredAccess, int bInheritHandle, uint32_t dwProcessId)'),
    image: kernel32.func('int __stdcall QueryFullProcessImageNameW(intptr_t hProcess, uint32_t dwFlags, void *lpExeName, void *lpdwSize)'),
    close: kernel32.func('int __stdcall CloseHandle(intptr_t hObject)'),
    fg: user32.func('intptr_t __stdcall GetForegroundWindow()'),
    pid: user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hWnd, void *lpdwProcessId)'),
    rect: user32.func('int __stdcall GetWindowRect(intptr_t hWnd, void *lpRect)'),
    dwm: dwmapi.func('long __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32_t dwAttribute, void *pvAttribute, uint32_t cbAttribute)'),
    text: user32.func('int __stdcall GetWindowTextW(intptr_t hWnd, void *lpString, int nMaxCount)'),
    cls: user32.func('int __stdcall GetClassNameW(intptr_t hWnd, void *lpClassName, int nMaxCount)'),
    iconic: user32.func('int __stdcall IsIconic(intptr_t hWnd)'),
  };
  return api;
}

const DWMWA_EXTENDED_FRAME_BOUNDS = 9;

function readRect(buf: Buffer): PhysRect {
  const left = buf.readInt32LE(0);
  const top = buf.readInt32LE(4);
  return { x: left, y: top, width: buf.readInt32LE(8) - left, height: buf.readInt32LE(12) - top };
}

function wide(fn: Fn, hwnd: number): string {
  const buf = Buffer.alloc(512 * 2);
  const n = Number(fn(hwnd, buf, 512)) || 0;
  return buf.toString('utf16le', 0, Math.max(0, n) * 2);
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const exeByPid = new Map<number, string>();

/** The program a process runs, lower case ("onenote.exe"). Remembered per process. */
function exeOf(pid: number): string {
  const known = exeByPid.get(pid);
  if (known !== undefined) return known;
  const w = load();
  let name = '';
  const h = Number(w.open(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid));
  if (h) {
    const buf = Buffer.alloc(1024 * 2);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(1024);
    if (Number(w.image(h, 0, buf, size)) !== 0) {
      const full = buf.toString('utf16le', 0, size.readUInt32LE(0) * 2);
      name = full.slice(full.lastIndexOf('\\') + 1).toLowerCase();
    }
    w.close(h);
  }
  if (exeByPid.size > 500) exeByPid.clear();
  exeByPid.set(pid, name);
  return name;
}

/** The window in front right now, or null (no window, or not on Windows). */
export function foregroundWindow(): WinInfo | null {
  if (process.platform !== 'win32') return null;
  const w = load();
  const hwnd = Number(w.fg());
  if (!hwnd) return null;
  const pidBuf = Buffer.alloc(4);
  w.pid(hwnd, pidBuf);
  const rectBuf = Buffer.alloc(16);
  const ok = Number(w.dwm(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, rectBuf, 16)) === 0 || Number(w.rect(hwnd, rectBuf)) !== 0;
  if (!ok) return null;
  const pid = pidBuf.readUInt32LE(0);
  return {
    hwnd,
    pid,
    title: wide(w.text, hwnd),
    cls: wide(w.cls, hwnd),
    rect: readRect(rectBuf),
    minimized: Number(w.iconic(hwnd)) !== 0,
    exe: exeOf(pid),
  };
}

