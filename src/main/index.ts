import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { existsSync, readFileSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { addVault, loadRegistry, saveRegistry, type Registry } from './vaults.ts'
import { createEntry, inVault, listTree, moveEntry, nestNote, renameEntry } from './files.ts'
import { COVERS, countNotes, createBook, readMeta, writeMeta } from './books.ts'
import { loadSettings, saveSettings, type Settings } from './settings.ts'
import { buildPrompt, outline, parentNotes, SYSTEM, type AiRequest } from './prompt.ts'
import { claudeCode, findClaude, openaiCompatible, type Generate } from './ai.ts'

const userFile = (name: string) => join(app.getPath('userData'), name)
let vaults: Registry = {}
let settings: Settings
let quitting = false

// Every window shows the library (vault null) or one book.
type Win = { vault: string | null; watcher?: FSWatcher }
const windows = new Map<BrowserWindow, Win>()

const save = () => saveRegistry(userFile('vaults.json'), vaults)
const library = () => settings.library || join(app.getPath('documents'), 'Books')

function createWindow(vault: string | null): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: { preload: join(__dirname, '../preload/index.js') }
  })
  windows.set(win, { vault: null })
  if (vault) attach(win, vault)
  // electron-vite sets this in dev; in builds load the bundled file.
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  win.on('closed', () => {
    const w = windows.get(win)!
    w.watcher?.close()
    windows.delete(win)
    // Keep the flag on quit or when the last window closes, so the next launch reopens it.
    if (w.vault && !quitting && windows.size > 0) {
      delete vaults[w.vault].open
      save()
    }
  })
  return win
}

// Points a window at a book (or back at the library) and watches the book folder.
function attach(win: BrowserWindow, id: string | null): void {
  const w = windows.get(win)!
  w.watcher?.close()
  w.watcher = undefined
  if (w.vault && w.vault !== id) delete vaults[w.vault].open
  w.vault = id
  if (id) {
    vaults[id].open = true
    // Tell the renderer when anything in the book changes on disk (debounced).
    let timer: NodeJS.Timeout | undefined
    w.watcher = watch(vaults[id].path, { recursive: true }, () => {
      clearTimeout(timer)
      timer = setTimeout(() => win.isDestroyed() || win.webContents.send('fs:changed'), 100)
    }).on('error', () => {})
  }
  save()
}

const windowOf = (e: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender)!
const windowWith = (id: string) => [...windows].find(([, w]) => w.vault === id)?.[0]

// Opens a folder as a book in the calling window (or focuses the window that has it).
function openBook(e: IpcMainInvokeEvent, path: string, newWindow = false): string | null {
  const result = addVault(vaults, path)
  if ('error' in result) return result.error
  save()
  app.addRecentDocument(path)
  const other = windowWith(result.id)
  if (other) other.focus()
  else if (newWindow) createWindow(result.id)
  else {
    attach(windowOf(e), result.id)
    e.sender.reload()
  }
  return null
}

// --- Books (library page) ---

ipcMain.handle('book:list', () =>
  Object.entries(vaults)
    .map(([id, v]) => {
      const missing = !statSync(v.path, { throwIfNoEntry: false })?.isDirectory()
      return { id, path: v.path, ts: v.ts, title: basename(v.path), missing, notes: missing ? 0 : countNotes(v.path), ...readMeta(v.path) }
    })
    .sort((a, b) => b.ts - a.ts)
)
ipcMain.handle('book:covers', () => COVERS)
ipcMain.handle('book:create', (e, title: string, color: string) => {
  const r = createBook(library(), title, color)
  return 'error' in r ? r.error : openBook(e, r.path)
})
ipcMain.handle('book:open', (e, id: string, newWindow?: boolean) => openBook(e, vaults[id].path, newWindow))
ipcMain.handle('book:pick', async (e) => {
  const r = await dialog.showOpenDialog(windowOf(e), { properties: ['openDirectory', 'createDirectory'] })
  return r.canceled ? null : openBook(e, r.filePaths[0])
})
ipcMain.handle('book:close', (e) => {
  attach(windowOf(e), null)
  e.sender.reload()
})
ipcMain.handle('book:current', (e) => {
  const id = windows.get(windowOf(e))?.vault
  return id ? { id, path: vaults[id].path, title: basename(vaults[id].path) } : null
})
ipcMain.handle('book:rename', (_e, id: string, title: string) => {
  if (windowWith(id)) return 'Close the book before renaming it'
  const path = vaults[id].path
  const r = renameEntry(dirname(path), basename(path), title)
  if ('error' in r) return r.error
  vaults[id].path = join(dirname(path), r.path)
  save()
  return null
})
ipcMain.handle('book:color', (_e, id: string, color: string) => writeMeta(vaults[id].path, { ...readMeta(vaults[id].path), color }))
ipcMain.handle('book:reveal', (_e, id: string) => shell.openPath(vaults[id].path))
// Forgets a book; with `trash` also moves its folder to the OS trash.
ipcMain.handle('book:remove', async (_e, id: string, trash: boolean) => {
  if (windowWith(id)) return 'Close the book first'
  if (trash && existsSync(vaults[id].path)) {
    const ok = await shell.trashItem(vaults[id].path).then(() => true, () => false)
    if (!ok) return "Couldn't move the folder to the trash"
  }
  delete vaults[id]
  save()
  return null
})

// --- Files inside the window's book ---

// Folder of the book that owns the calling window.
function vaultOf(e: IpcMainInvokeEvent): string {
  const id = windows.get(windowOf(e))?.vault
  if (!id) throw new Error('Window has no book')
  return vaults[id].path
}

ipcMain.handle('fs:list', (e) => listTree(vaultOf(e)))
ipcMain.handle('fs:read', (e, rel: string) => readFileSync(inVault(vaultOf(e), rel), 'utf8'))
ipcMain.handle('fs:write', (e, rel: string, text: string) => writeFileSync(inVault(vaultOf(e), rel), text))
ipcMain.handle('fs:rename', (e, rel: string, name: string) => renameEntry(vaultOf(e), rel, name))
ipcMain.handle('fs:nest', (e, rel: string) => nestNote(vaultOf(e), rel))
ipcMain.handle('fs:move', (e, rel: string, dest: string) => moveEntry(vaultOf(e), rel, dest))
// Moves to the OS trash; false when the filesystem has none (e.g. tmpfs).
ipcMain.handle('fs:trash', (e, rel: string) => shell.trashItem(inVault(vaultOf(e), rel)).then(() => true, () => false))
ipcMain.handle('fs:remove', (e, rel: string) => rmSync(inVault(vaultOf(e), rel), { recursive: true }))
ipcMain.handle('fs:create', (e, folder: boolean, parent = '') => createEntry(vaultOf(e), parent, folder))

// --- Settings ---

// The renderer never sees the stored API key, only whether there is one.
const publicSettings = () => ({ ...settings, library: library(), ai: { ...settings.ai, openai: { ...settings.ai.openai, apiKey: settings.ai.openai.apiKey ? '••••••••' : '' } } })

ipcMain.handle('settings:get', () => publicSettings())
ipcMain.handle('settings:set', (_e, s: Settings) => {
  const key = s.ai.openai.apiKey === '••••••••' ? settings.ai.openai.apiKey : s.ai.openai.apiKey
  settings = { ...s, ai: { ...s.ai, openai: { ...s.ai.openai, apiKey: key } } }
  saveSettings(userFile('settings.json'), settings)
  return publicSettings()
})
ipcMain.handle('settings:pickLibrary', async (e) => {
  const r = await dialog.showOpenDialog(windowOf(e), { defaultPath: library(), properties: ['openDirectory', 'createDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})

// --- AI ---

async function generator(): Promise<Generate> {
  const ai = settings.ai
  if (ai.provider === 'openai') return openaiCompatible(ai.openai)
  const path = await findClaude(ai.claudePath)
  if (!path)
    throw new Error(
      ai.claudePath
        ? `Claude Code not found at ${ai.claudePath}`
        : 'Claude Code not found. Install it (npm i -g @anthropic-ai/claude-code), then run `claude` once to log in, or set its path in Settings.'
    )
  return claudeCode(path, ai.claudeModel, userFile('ai-workdir'))
}

const jobs = new Map<string, AbortController>()

// Streams generated text to the renderer as ai:chunk events; resolves to an error message or null.
ipcMain.handle('ai:generate', async (e, id: string, req: AiRequest) => {
  const abort = new AbortController()
  jobs.set(id, abort)
  try {
    const root = vaultOf(e)
    const parents = parentNotes(req.path)
      .filter((p) => existsSync(inVault(root, p)))
      .map((p) => ({ title: basename(p, '.md'), text: readFileSync(inVault(root, p), 'utf8') }))
    const prompt = buildPrompt({ ...req, book: basename(root), outline: outline(listTree(root), req.path), parents })
    const run = await generator()
    await run(prompt, SYSTEM, (text) => e.sender.isDestroyed() || e.sender.send('ai:chunk', id, text), abort.signal)
    return null
  } catch (err) {
    return (err as Error).message
  } finally {
    jobs.delete(id)
  }
})
ipcMain.handle('ai:cancel', (_e, id: string) => jobs.get(id)?.abort())
ipcMain.handle('ai:detectClaude', () => findClaude(''))
// Sends a tiny prompt with the current settings; resolves to { text } or { error }.
ipcMain.handle('ai:test', async () => {
  let text = ''
  try {
    const run = await generator()
    await run('Reply with exactly: Hello from your AI provider!', SYSTEM, (t) => (text += t), new AbortController().signal)
    return { text }
  } catch (err) {
    return { error: (err as Error).message }
  }
})

app.whenReady().then(() => {
  vaults = loadRegistry(userFile('vaults.json'))
  settings = loadSettings(userFile('settings.json'))
  for (const id in vaults) {
    if (!vaults[id].open) continue
    if (statSync(vaults[id].path, { throwIfNoEntry: false })?.isDirectory()) createWindow(id)
    else delete vaults[id].open
  }
  if (windows.size === 0) createWindow(null)
})
app.on('before-quit', () => (quitting = true))
app.on('window-all-closed', () => app.quit())
