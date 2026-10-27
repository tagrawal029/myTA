// tanrushu only shows up where homework happens: note-taking apps, whiteboards and drawing apps, documents and PDFs you write on.
// Everywhere else (games, Spotify, email, a browser on YouTube) it stays out of the way. Desktop apps are known by their program; apps
// that run inside a browser, or inside Windows' app frame (Store apps), are known by the window title.
import { parseAddress } from './browserUrl';
import type { WinInfo } from './win32';

/** Programs that are note-taking, whiteboard, drawing, document or PDF apps. */
const NOTE_PROGRAMS = new Set([
  'onenote.exe',
  'onenoteim.exe',
  'notion.exe',
  'obsidian.exe',
  'evernote.exe',
  'joplin.exe',
  'logseq.exe',
  'typora.exe',
  'xournalpp.exe',
  'xournal.exe',
  'mspaint.exe',
  'paint.exe',
  'paintdotnet.exe',
  'krita.exe',
  'sketchbook.exe',
  'whiteboard.exe',
  'microsoft.whiteboard.exe',
  'microsoft.notes.exe',
  'stickynotes.exe',
  'winword.exe',
  'notepad.exe',
  'notepad++.exe',
  'acrord32.exe',
  'acrobat.exe',
  'sumatrapdf.exe',
  'foxitpdfreader.exe',
  'foxitpdfeditor.exe',
  'pdfxedit.exe',
  'drawboard.pdf.exe',
  'nebo.exe',
  'goodnotes.exe',
  'zotero.exe',
  'rnote.exe',
  'miro.exe',
  'mathpix snipping tool.exe',
]);

/** Browsers: what they show is only a notes app when the SITE is one, never because a word appears in the page's title. */
export const BROWSERS = new Set(['chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'opera_gx.exe', 'vivaldi.exe', 'arc.exe', 'nortonbrowser.exe', 'avastbrowser.exe', 'iexplore.exe']);

/**
 * Names of notes, whiteboard and document apps as they appear as a whole part of a window title: the site part of a browser tab
 * ("Lecture 5 - Google Docs - Google Chrome"), or the app part of a Store app's window ("Calc - OneNote for Windows 10").
 */
const APP_NAMES = new Set([
  'onenote',
  'onenote for windows 10',
  'onenote for the web',
  'notion',
  'obsidian',
  'evernote',
  'excalidraw',
  'miro',
  'tldraw',
  'jamboard',
  'figjam',
  'google docs',
  'google keep',
  'microsoft word',
  'word',
  'word online',
  'microsoft whiteboard',
  'whiteboard',
  'zoom whiteboard',
  'goodnotes',
  'notability',
  'xournal++',
  'drawboard pdf',
  'nebo',
  'sticky notes',
  'overleaf',
  'desmos',
  'geogebra',
  'kami',
  'paint',
  'notepad',
]);

/** The parts of a window title ("Calc notes - OneNote - Google Chrome" → ["Calc notes", "OneNote", "Google Chrome"]). */
function titleParts(title: string): string[] {
  return title
    .split(/\s+[-–—|·]\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Notes, whiteboard and document sites, by domain (a subdomain counts too). Checked against the address of the tab in front, which is the
 * surest sign of what you're on. `path` narrows a domain that also hosts other things (Google's docs vs. sheets, Figma's whiteboards).
 */
const NOTE_SITES: { host: string; path?: RegExp }[] = [
  { host: 'onenote.com' },
  { host: 'onenote.officeapps.live.com' },
  { host: 'notion.so' },
  { host: 'notion.site' },
  { host: 'docs.google.com', path: /^\/(document|drawings|presentation)\// },
  { host: 'keep.google.com' },
  { host: 'jamboard.google.com' },
  { host: 'canvas.apps.chrome' },
  { host: 'miro.com' },
  { host: 'excalidraw.com' },
  { host: 'tldraw.com' },
  { host: 'whiteboard.office.com' },
  { host: 'whiteboard.microsoft.com' },
  { host: 'mural.co' },
  { host: 'figma.com', path: /^\/board\// },
  { host: 'lucid.app', path: /lucidspark|\/board\b/i },
  { host: 'conceptboard.com' },
  { host: 'webwhiteboard.com' },
  { host: 'whiteboard.fi' },
  { host: 'awwapp.com' },
  { host: 'ziteboard.com' },
  { host: 'witeboard.com' },
  { host: 'explaineverything.com' },
  { host: 'excalidraw.net' },
  { host: 'draw.io' },
  { host: 'app.diagrams.net' },
  { host: 'desmos.com' },
  { host: 'geogebra.org' },
  { host: 'overleaf.com' },
  { host: 'kamiapp.com' },
  { host: 'kamihq.com' },
  { host: 'goodnotes.com' },
  { host: 'notability.com' },
  { host: 'evernote.com' },
  { host: 'remnote.com' },
  { host: 'roamresearch.com' },
  { host: 'logseq.com' },
  { host: 'simplenote.com' },
  { host: 'craft.do' },
  { host: 'word.cloud.microsoft' },
  { host: 'word-edit.officeapps.live.com' },
  { host: 'zoom.us', path: /whiteboard/i },
];

/** Sites that are never notes apps, by domain: search, email, video, social, shopping, chat. */
const NOT_NOTE_SITES = ['google.com', 'bing.com', 'duckduckgo.com', 'mail.google.com', 'outlook.live.com', 'outlook.office.com', 'youtube.com', 'reddit.com', 'wikipedia.org', 'amazon.com', 'instagram.com', 'facebook.com', 'x.com', 'twitter.com', 'linkedin.com', 'netflix.com', 'spotify.com', 'discord.com', 'chatgpt.com', 'claude.ai', 'tiktok.com', 'twitch.tv'];

const hostIs = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** What the tab's address says: a notes site (true), a site that never is (false), or nothing either way (null). */
export function siteVerdict(url: string | undefined): boolean | null {
  const u = url ? parseAddress(url) : null;
  if (!u) return null;
  if (/\.pdf$/i.test(u.pathname)) return true;
  if (u.protocol === 'file:') return null;
  const host = u.hostname.toLowerCase();
  if (NOTE_SITES.some((s) => hostIs(host, s.host) && (!s.path || s.path.test(u.pathname)))) return true;
  if (NOT_NOTE_SITES.some((d) => hostIs(host, d))) return false;
  return null;
}

/** Words that, in the site's own name ("Web Whiteboard", "Online Notebook"), mean a whiteboard or notes app. */
const NOTE_WORDS = /\b(whiteboard|white board|notebook|note-taking|notes app|sketchpad|drawing board|canvas board)\b/i;

/**
 * Whether this window is a notes, whiteboard, drawing, document or PDF app. `url` is the address of the tab in front when the window is
 * a browser (read from its address bar); without it, the tab's title is the only clue.
 */
export function isNotesApp(w: (Pick<WinInfo, 'exe' | 'title'> & { url?: string }) | null): boolean {
  if (!w) return false;
  const exe = (w.exe ?? '').toLowerCase();
  if (NOTE_PROGRAMS.has(exe)) return true;
  const browser = BROWSERS.has(exe);
  // The address decides when it's clear (a notes site, or a site that never is one).
  const verdict = browser ? siteVerdict(w.url) : null;
  if (verdict !== null) return verdict;
  let parts = titleParts(w.title);
  // A browser puts its own name last; what matters is the site before it.
  if (browser && parts.length > 1) parts = parts.slice(0, -1);
  if (!parts.length) return false;
  // A PDF that is open (in a browser or a reader we don't know): its file name comes first.
  if (/\.pdf$/i.test(parts[0])) return true;
  // Sites that are never notes apps, whatever their page is about: a search for "Notion", an email titled "Whiteboard".
  const lower = parts.map((p) => p.toLowerCase());
  if (lower.some((p) => NOT_NOTES.has(p))) return false;
  // "Overleaf, Online LaTeX Editor": the app's name, then its tagline.
  const app = (p: string) => APP_NAMES.has(p) || APP_NAMES.has(p.split(/[,:]/)[0].trim());
  // The app's name must be a whole part of the title. Usually it comes after the page or document name ("Lecture 5 - Google Docs"),
  // and the first part is left out, because a document name can be anything. A short title may lead with the app ("Desmos | Graphing
  // Calculator", or just "Miro").
  const appParts = lower.length > 2 ? lower.slice(1) : lower;
  if (appParts.some(app)) return true;
  // A whiteboard or notes site we don't know by name: in a browser, a site whose own name says so ("… | Web Whiteboard"). Only the
  // site's name (the last part) counts, never the page's ("Best whiteboard apps - The Verge" is an article, not a whiteboard).
  return browser && NOTE_WORDS.test(lower[lower.length - 1]);
}

/** Title parts of sites that are never notes apps (search engines, email, video, social and shopping sites). */
const NOT_NOTES = new Set([
  'google search',
  'bing',
  'search',
  'duckduckgo',
  'gmail',
  'outlook',
  'mail',
  'youtube',
  'reddit',
  'wikipedia',
  'amazon.com',
  'instagram',
  'facebook',
  'x',
  'twitter',
  'linkedin',
  'netflix',
  'spotify',
  'discord',
  'chatgpt',
  'claude',
]);

/** The window (and, in a browser, the tab) the student called tanrushu on by hand. */
export interface CalledOn {
  hwnd: number;
  title: string;
}

/**
 * Whether tanrushu is on screen for this window: in a notes/whiteboard app, in the window and tab the student called it on themselves
 * (the hotkey or the tray), or everywhere when they turned that on in setup.
 */
export function showFor(w: (Pick<WinInfo, 'exe' | 'title' | 'hwnd'> & { url?: string }) | null, opts: { everywhere: boolean; calledOn: CalledOn | null }): boolean {
  if (opts.everywhere) return true;
  if (!w) return false;
  // A browser keeps one window for all its tabs, so a hand call counts for that tab only (its title), not every tab in the window.
  return isNotesApp(w) || (opts.calledOn !== null && w.hwnd === opts.calledOn.hwnd && w.title === opts.calledOn.title);
}
