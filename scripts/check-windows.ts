// Lists every visible window on this computer and whether tanrushu would show on it, using the same check the app uses.
// Run: npx vite-node scripts/check-windows.ts
import koffi from 'koffi';
import { BrowserUrlReader } from '../src/main/browserUrl';
import { BROWSERS, isNotesApp } from '../src/main/notesApps';

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const EnumProc = koffi.proto('int __stdcall EnumProc(intptr_t hwnd, intptr_t lParam)');
const EnumWindows = user32.func('int __stdcall EnumWindows(EnumProc *cb, intptr_t lParam)');
const IsWindowVisible = user32.func('int __stdcall IsWindowVisible(intptr_t hWnd)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(intptr_t hWnd, void *buf, int max)');
const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hWnd, void *pid)');
const OpenProcess = kernel32.func('intptr_t __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)');
const QueryFullProcessImageNameW = kernel32.func('int __stdcall QueryFullProcessImageNameW(intptr_t h, uint32_t flags, void *buf, void *size)');
const CloseHandle = kernel32.func('int __stdcall CloseHandle(intptr_t h)');

function exeOf(pid: number): string {
  const h = Number(OpenProcess(0x1000, 0, pid));
  if (!h) return '';
  const buf = Buffer.alloc(2048);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(1024);
  const ok = Number(QueryFullProcessImageNameW(h, 0, buf, size)) !== 0;
  CloseHandle(h);
  if (!ok) return '';
  const full = buf.toString('utf16le', 0, size.readUInt32LE(0) * 2);
  return full.slice(full.lastIndexOf('\\') + 1).toLowerCase();
}

const rows: { title: string; exe: string; hwnd: number; url?: string }[] = [];
const cb = koffi.register((hwnd: number) => {
  if (!Number(IsWindowVisible(hwnd))) return 1;
  const buf = Buffer.alloc(1024);
  const n = Number(GetWindowTextW(hwnd, buf, 512));
  const title = buf.toString('utf16le', 0, n * 2);
  if (!title.trim()) return 1;
  const pid = Buffer.alloc(4);
  GetWindowThreadProcessId(hwnd, pid);
  rows.push({ title, exe: exeOf(pid.readUInt32LE(0)), hwnd: Number(hwnd) });
  return 1;
}, koffi.pointer(EnumProc));
EnumWindows(cb, 0);
koffi.unregister(cb);

// Browsers: read the address of the tab in front, as the app does.
const reader = new BrowserUrlReader();
for (const r of rows) if (BROWSERS.has(r.exe)) r.url = (await reader.read(r.hwnd)) || undefined;
reader.stop();
for (const r of rows) console.log(`${isNotesApp(r) ? 'SHOW' : 'hide'}  ${r.exe.padEnd(26)} ${r.title}${r.url ? `   [${r.url}]` : ''}`);
