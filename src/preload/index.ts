import { contextBridge, ipcRenderer } from 'electron'
import type { Entry } from '../main/files.ts'

type VaultInfo = { id: string; path: string; ts: number }

// The only main-process API the renderer can reach. File paths are vault-relative.
const api = {
  listVaults: (): Promise<VaultInfo[]> => ipcRenderer.invoke('vault:list'),
  currentVault: (): Promise<{ id: string; path: string } | null> => ipcRenderer.invoke('vault:current'),
  openVault: (path: string): Promise<string | null> => ipcRenderer.invoke('vault:open', path),
  pickVault: (): Promise<string | null> => ipcRenderer.invoke('vault:pick'),
  files: {
    list: (): Promise<Entry[]> => ipcRenderer.invoke('fs:list'),
    read: (path: string): Promise<string> => ipcRenderer.invoke('fs:read', path),
    write: (path: string, text: string): Promise<void> => ipcRenderer.invoke('fs:write', path, text),
    create: (folder: boolean): Promise<string> => ipcRenderer.invoke('fs:create', folder),
    rename: (path: string, name: string): Promise<{ path: string } | { error: string }> =>
      ipcRenderer.invoke('fs:rename', path, name),
    trash: (path: string): Promise<boolean> => ipcRenderer.invoke('fs:trash', path),
    remove: (path: string): Promise<void> => ipcRenderer.invoke('fs:remove', path),
    onChange: (cb: () => void) => void ipcRenderer.on('fs:changed', () => cb())
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
