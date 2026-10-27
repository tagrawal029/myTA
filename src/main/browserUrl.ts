// The web address of the tab in front of a browser window, read the way screen readers read it: Windows UI Automation's view of the
// address bar. That tells tanrushu what site you're on (webwhiteboard.com, docs.google.com…) instead of guessing from the tab's title.
// One PowerShell process stays open and answers one window at a time, so each look takes a fraction of a second.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const SCRIPT = `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$edit = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $out = ''
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]$line)
    $e = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $edit)
    if ($e) { $out = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value }
  } catch { $out = '' }
  [Console]::Out.WriteLine(($out -replace '[\\r\\n]', ' '))
  [Console]::Out.Flush()
}
`;

/** Turns what the address bar shows ("webwhiteboard.com", "https://docs.google.com/document/d/…") into a URL, or null. */
export function parseAddress(text: string): URL | null {
  const t = text.trim();
  if (!t || /\s/.test(t)) return null;
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return new URL(t);
    // Browsers hide "https://" in the address bar.
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(t)) return new URL(`https://${t}`);
  } catch {
    /* not an address */
  }
  return null;
}

export class BrowserUrlReader {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private waiting: { resolve: (v: string) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  private failed = false;

  private start(): ChildProcessWithoutNullStreams | null {
    if (this.proc || this.failed || process.platform !== 'win32') return this.proc;
    try {
      const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
      this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
      this.proc.stdout.setEncoding('utf8');
      this.proc.stdout.on('data', (d: string) => {
        this.buffer += d;
        let i: number;
        while ((i = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, i).replace(/\r$/, '');
          this.buffer = this.buffer.slice(i + 1);
          const w = this.waiting.shift();
          if (w) {
            clearTimeout(w.timer);
            w.resolve(line);
          }
        }
      });
      this.proc.on('exit', () => {
        this.proc = null;
        this.waiting.splice(0).forEach((w) => w.resolve(''));
      });
      this.proc.on('error', () => {
        this.failed = true;
        this.proc = null;
      });
    } catch {
      this.failed = true;
      this.proc = null;
    }
    return this.proc;
  }

  /** What the address bar of this browser window shows, or "" when it can't be read (in under 2.5 s). */
  read(hwnd: number): Promise<string> {
    const p = this.start();
    if (!p) return Promise.resolve('');
    return new Promise((resolve) => {
      // A look that hangs (a window closing mid-look) gives up, and the next look starts a fresh helper.
      const timer = setTimeout(() => {
        const i = this.waiting.findIndex((w) => w.timer === timer);
        if (i >= 0) this.waiting.splice(i, 1);
        resolve('');
        this.stop();
      }, 2500);
      this.waiting.push({ resolve, timer });
      p.stdin.write(`${hwnd}\n`);
    });
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
    this.buffer = '';
    this.waiting.splice(0).forEach((w) => {
      clearTimeout(w.timer);
      w.resolve('');
    });
  }
}
