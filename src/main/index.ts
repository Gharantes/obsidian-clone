import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { mkdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addVault, loadRegistry, saveRegistry, type Registry } from './vaults.ts'
import { availablePath, inVault, listTree, renameEntry } from './files.ts'

const registryFile = () => join(app.getPath('userData'), 'vaults.json')
let vaults: Registry = {}
const vaultWindows = new Map<string, BrowserWindow>()
let picker: BrowserWindow | null = null
let quitting = false

const save = () => saveRegistry(registryFile(), vaults)

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 750,
    webPreferences: { preload: join(__dirname, '../preload/index.js') }
  })
  // electron-vite sets this in dev; in builds load the bundled file.
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

function showPicker(): void {
  if (picker) return picker.focus()
  picker = createWindow()
  picker.on('closed', () => (picker = null))
}

function openVaultWindow(id: string): void {
  const existing = vaultWindows.get(id)
  if (existing) return existing.focus()

  const win = createWindow()
  vaultWindows.set(id, win)
  vaults[id].open = true
  save()

  // Tell the renderer when anything in the vault changes on disk (debounced).
  let timer: NodeJS.Timeout | undefined
  const watcher = watch(vaults[id].path, { recursive: true }, () => {
    clearTimeout(timer)
    timer = setTimeout(() => win.isDestroyed() || win.webContents.send('fs:changed'), 100)
  }).on('error', () => {})

  win.on('closed', () => {
    watcher.close()
    vaultWindows.delete(id)
    // Keep the flag on quit or when the last window closes, so the next launch reopens it.
    if (!quitting && vaultWindows.size > 0) {
      delete vaults[id].open
      save()
    }
  })
}

// Opens a folder as a vault; returns an error message or null.
function openVault(path: string): string | null {
  const result = addVault(vaults, path)
  if ('error' in result) return result.error
  save()
  openVaultWindow(result.id)
  app.addRecentDocument(path)
  picker?.close()
  return null
}

ipcMain.handle('vault:list', () =>
  Object.entries(vaults)
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.ts - a.ts)
)
ipcMain.handle('vault:current', (e) => {
  for (const [id, win] of vaultWindows) if (win.webContents === e.sender) return { id, path: vaults[id].path }
  return null
})
ipcMain.handle('vault:open', (_e, path: string) => openVault(path))
ipcMain.handle('vault:pick', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)!
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
  return r.canceled ? null : openVault(r.filePaths[0])
})

// Folder of the vault that owns the calling window.
function vaultOf(e: IpcMainInvokeEvent): string {
  for (const [id, win] of vaultWindows) if (win.webContents === e.sender) return vaults[id].path
  throw new Error('Window has no vault')
}

ipcMain.handle('fs:list', (e) => listTree(vaultOf(e)))
ipcMain.handle('fs:read', (e, rel: string) => readFileSync(inVault(vaultOf(e), rel), 'utf8'))
ipcMain.handle('fs:write', (e, rel: string, text: string) => writeFileSync(inVault(vaultOf(e), rel), text))
ipcMain.handle('fs:rename', (e, rel: string, name: string) => renameEntry(vaultOf(e), rel, name))
// Moves to the OS trash; false when the filesystem has none (e.g. tmpfs).
ipcMain.handle('fs:trash', (e, rel: string) => shell.trashItem(inVault(vaultOf(e), rel)).then(() => true, () => false))
ipcMain.handle('fs:remove', (e, rel: string) => rmSync(inVault(vaultOf(e), rel), { recursive: true }))
ipcMain.handle('fs:create', (e, folder: boolean) => {
  const root = vaultOf(e)
  const path = availablePath(root, 'Untitled', folder ? '' : 'md')
  if (folder) mkdirSync(inVault(root, path))
  else writeFileSync(inVault(root, path), '')
  return path
})

app.whenReady().then(() => {
  vaults = loadRegistry(registryFile())
  for (const id in vaults) if (vaults[id].open && openVault(vaults[id].path)) delete vaults[id].open
  if (vaultWindows.size === 0) showPicker()
})
app.on('before-quit', () => (quitting = true))
app.on('window-all-closed', () => app.quit())
