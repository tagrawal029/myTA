// The only bridge between myTA's pages and the main process. Pages get these functions and nothing else: no Node, no Electron.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ActiveClass, ClassInfo } from '../core/shared/classes';
import type { MySprite, OverlayAction, SettingsView, UiState } from '../core/shared/ui';

/** The classes as the overlay needs them: names and colours, the choice, and the class in use right now. */
export interface ClassesBrief {
  list: { id: string; name: string; color: string }[];
  active: ActiveClass;
  inUse: { id: string; name: string; color: string } | null;
}

type Area = { x: number; y: number; width: number; height: number };

function on<T>(channel: string, cb: (v: T) => void): () => void {
  const fn = (_e: IpcRendererEvent, v: T) => cb(v);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
}

const api = {
  /** tanrushu's own window: the monkey, its options and its speech bubble. */
  overlay: {
    get: (): Promise<{ state: UiState; classes: ClassesBrief; sprite: MySprite; side: 'left' | 'right' }> => ipcRenderer.invoke('ui:get'),
    onClasses: (cb: (c: ClassesBrief) => void) => on('ui:classes', cb),
    setClass: (id: ActiveClass) => ipcRenderer.send('ui:setClass', id),
    onState: (cb: (s: UiState) => void) => on('ui:state', cb),
    onSprite: (cb: (s: MySprite) => void) => on('ui:sprite', cb),
    /** Which side of tanrushu the speech bubble opens on (the side with room). */
    onSide: (cb: (side: 'left' | 'right') => void) => on('ui:side', cb),
    act: (a: OverlayAction | { type: string; arg?: string; url?: string; concept?: string }) => ipcRenderer.send('ui:act', a),
    /** The size of what's in the window, so the window can be exactly that big. */
    size: (s: { w: number; h: number; stackLeft: number; stackWidth: number }) => ipcRenderer.send('dock:size', s),
    /** Dragging tanrushu: how far the pointer has moved since the drag started, in screen pixels. */
    drag: (d: { dx: number; dy: number; end: boolean }) => ipcRenderer.send('dock:drag', d),
  },
  /** The see-through layer over the screen: the red square and the confetti. */
  marks: {
    get: (): Promise<{ state: UiState; dock: Area | null }> => ipcRenderer.invoke('marks:get'),
    onState: (cb: (s: UiState) => void) => on('ui:state', cb),
    /** Where tanrushu's window is, in the layer's coordinates (confetti comes from there). */
    onDock: (cb: (a: Area) => void) => on('marks:dock', cb),
    /** The parts of the layer that take clicks (the square's label with its ×, and its thin frame); null: none, everything goes through. */
    hit: (rects: Area[] | null) => ipcRenderer.send('marks:hit', rects),
    /** The × on the square's label. */
    close: () => ipcRenderer.send('ui:act', { type: 'hideMark' }),
  },
  settings: {
    get: (): Promise<SettingsView> => ipcRenderer.invoke('settings:get'),
    saveKeys: (k: { gemini?: string; serp?: string; model?: string; solverModel?: string }): Promise<SettingsView> => ipcRenderer.invoke('settings:saveKeys', k),
    test: (): Promise<{ gemini: { ok: boolean; detail: string }; serp: { ok: boolean; detail: string }; view: SettingsView }> => ipcRenderer.invoke('settings:test'),
    onChanged: (cb: (v: SettingsView) => void) => on('settings:changed', cb),
    paste: (): Promise<string> => ipcRenderer.invoke('settings:paste'),
    open: (url: string): Promise<void> => ipcRenderer.invoke('settings:open', url),
    saveSprite: (s: MySprite): Promise<SettingsView> => ipcRenderer.invoke('settings:sprite', s),
    hideFromCapture: (on: boolean): Promise<SettingsView> => ipcRenderer.invoke('settings:hideFromCapture', on),
    showEverywhere: (on: boolean): Promise<SettingsView> => ipcRenderer.invoke('settings:showEverywhere', on),
  },
  classes: {
    add: (name: string): Promise<{ view: SettingsView; id: string }> => ipcRenderer.invoke('classes:add', name),
    save: (c: ClassInfo): Promise<SettingsView> => ipcRenderer.invoke('classes:save', c),
    remove: (id: string): Promise<SettingsView> => ipcRenderer.invoke('classes:delete', id),
    setActive: (id: ActiveClass): Promise<SettingsView> => ipcRenderer.invoke('classes:active', id),
    readSyllabus: (input: { classId: string; text: string; upTo: string; file?: { name: string; mimeType: string; data: string } | null }): Promise<{ view?: SettingsView; found?: string[]; error?: string }> =>
      ipcRenderer.invoke('classes:readSyllabus', input),
  },
  problem: {
    pick: (): Promise<{ name: string; kind: 'pdf' | 'image'; preview: string | null; sizeKb: number } | { error: string } | null> => ipcRenderer.invoke('problem:pick'),
    submit: (p: { which: string; photo?: string; useFile: boolean }): Promise<{ ok?: boolean; error?: string }> => ipcRenderer.invoke('problem:submit', p),
    useScreen: (p: { which: string }): Promise<{ ok: boolean }> => ipcRenderer.invoke('problem:screen', p),
  },
};

export type MytaApi = typeof api;
contextBridge.exposeInMainWorld('myta', api);
