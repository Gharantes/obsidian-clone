import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { addVault, loadRegistry, saveRegistry, type Registry } from './vaults.ts'

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
  win.on('closed', () => {
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

app.whenReady().then(() => {
  vaults = loadRegistry(registryFile())
  for (const id in vaults) if (vaults[id].open && openVault(vaults[id].path)) delete vaults[id].open
  if (vaultWindows.size === 0) showPicker()
})
app.on('before-quit', () => (quitting = true))
app.on('window-all-closed', () => app.quit())
