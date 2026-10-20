import { contextBridge, ipcRenderer } from 'electron'
import type { Entry } from '../main/files.ts'
import type { AiRequest } from '../main/prompt.ts'
import type { Settings } from '../main/settings.ts'

export type Book = { id: string; path: string; ts: number; title: string; missing: boolean; notes: number; color?: string }
type Moved = Promise<{ path: string } | { error: string }>

// The only main-process API the renderer can reach. File paths are book-relative.
// Calls that can fail for a user-facing reason resolve to an error message (or null).
const api = {
  books: {
    list: (): Promise<Book[]> => ipcRenderer.invoke('book:list'),
    covers: (): Promise<string[]> => ipcRenderer.invoke('book:covers'),
    create: (title: string, color: string): Promise<string | null> => ipcRenderer.invoke('book:create', title, color),
    open: (id: string, newWindow = false): Promise<string | null> => ipcRenderer.invoke('book:open', id, newWindow),
    pick: (): Promise<string | null> => ipcRenderer.invoke('book:pick'),
    close: (): Promise<void> => ipcRenderer.invoke('book:close'),
    current: (): Promise<{ id: string; path: string; title: string } | null> => ipcRenderer.invoke('book:current'),
    rename: (id: string, title: string): Promise<string | null> => ipcRenderer.invoke('book:rename', id, title),
    setColor: (id: string, color: string): Promise<void> => ipcRenderer.invoke('book:color', id, color),
    reveal: (id: string): Promise<void> => ipcRenderer.invoke('book:reveal', id),
    remove: (id: string, trash: boolean): Promise<string | null> => ipcRenderer.invoke('book:remove', id, trash)
  },
  files: {
    list: (): Promise<Entry[]> => ipcRenderer.invoke('fs:list'),
    read: (path: string): Promise<string> => ipcRenderer.invoke('fs:read', path),
    write: (path: string, text: string): Promise<void> => ipcRenderer.invoke('fs:write', path, text),
    create: (folder: boolean, parent = ''): Promise<string> => ipcRenderer.invoke('fs:create', folder, parent),
    rename: (path: string, name: string): Moved => ipcRenderer.invoke('fs:rename', path, name),
    nest: (path: string): Moved => ipcRenderer.invoke('fs:nest', path),
    move: (path: string, dest: string): Moved => ipcRenderer.invoke('fs:move', path, dest),
    trash: (path: string): Promise<boolean> => ipcRenderer.invoke('fs:trash', path),
    remove: (path: string): Promise<void> => ipcRenderer.invoke('fs:remove', path),
    onChange: (cb: () => void) => void ipcRenderer.on('fs:changed', () => cb())
  },
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    set: (s: Settings): Promise<Settings> => ipcRenderer.invoke('settings:set', s),
    pickLibrary: (): Promise<string | null> => ipcRenderer.invoke('settings:pickLibrary')
  },
  ai: {
    generate: (id: string, req: AiRequest): Promise<string | null> => ipcRenderer.invoke('ai:generate', id, req),
    cancel: (id: string): Promise<void> => ipcRenderer.invoke('ai:cancel', id),
    onChunk: (cb: (id: string, text: string) => void) => void ipcRenderer.on('ai:chunk', (_e, id, text) => cb(id, text)),
    detectClaude: (): Promise<string | null> => ipcRenderer.invoke('ai:detectClaude'),
    test: (): Promise<{ text: string } | { error: string }> => ipcRenderer.invoke('ai:test')
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
