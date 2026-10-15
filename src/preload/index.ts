import { contextBridge, ipcRenderer } from 'electron'

type VaultInfo = { id: string; path: string; ts: number }

// The only main-process API the renderer can reach.
const api = {
  listVaults: (): Promise<VaultInfo[]> => ipcRenderer.invoke('vault:list'),
  currentVault: (): Promise<{ id: string; path: string } | null> => ipcRenderer.invoke('vault:current'),
  openVault: (path: string): Promise<string | null> => ipcRenderer.invoke('vault:open', path),
  pickVault: (): Promise<string | null> => ipcRenderer.invoke('vault:pick')
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
