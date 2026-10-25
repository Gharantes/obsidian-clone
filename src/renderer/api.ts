import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { buildPrompt, mentioned, outline, parentNotes, SYSTEM, type AiRequest, type Turn } from './prompt.ts'
import { stripMarkers } from './sections.ts'

// Folders carry `note` when they have a folder note ("X/X.md"); that note is left out of `children`.
export type Entry = { path: string; name: string; folder: boolean; note?: string; children?: Entry[] }

// `cover` is the name of the book's cover image, if it has one.
export type Book = { id: string; ts: number; title: string; notes: number; color: string; cover: string | null }

export type ApiConfig = { baseUrl: string; model: string; apiKey: string }

export type Settings = {
  ai: {
    // 'claude-code' or a key of `apis`.
    provider: string
    // Claude Code executable; empty means auto-detect.
    claudePath: string
    // Model alias or full id passed to `claude --model`; empty uses Claude Code's default.
    claudeModel: string
    // `claude --effort` (low … max); empty uses Claude Code's default.
    claudeEffort: string
    // OpenAI-compatible /chat/completions APIs by provider id (see APIS in settings.ts).
    apis: Record<string, ApiConfig>
  }
  image: {
    // Pollinations is free with no key; "openai" is any /images/generations server (stable-diffusion.cpp, LocalAI, ...).
    provider: 'pollinations' | 'openai'
    openai: ApiConfig
  }
}

type Moved = Promise<{ path: string } | { error: string }>

const on = (event: string, cb: (payload: any) => void) => void getCurrentWebviewWindow().listen(event, (e) => cb(e.payload))

// The backend API (src-tauri). File paths are book-relative.
// Calls that can fail for a user-facing reason resolve to an error message (or null).
const books = {
  list: (): Promise<Book[]> => invoke('book_list'),
  covers: (): Promise<string[]> => invoke('book_covers'),
  create: (title: string, color: string): Promise<string | null> => invoke('book_create', { title, color }),
  open: (id: string, newWindow = false): Promise<string | null> => invoke('book_open', { id, newWindow }),
  // Copies a folder (or a .zip) into a new book and opens it.
  import: (zip: boolean): Promise<string | null> => invoke('book_import', { zip }),
  export: (id: string): Promise<string | null> => invoke('book_export', { id }),
  close: (): Promise<void> => invoke('book_close'),
  current: (): Promise<{ id: string; title: string } | null> => invoke('book_current'),
  rename: (id: string, title: string): Promise<string | null> => invoke('book_rename', { id, title }),
  setColor: (id: string, color: string): Promise<void> => invoke('book_color', { id, color }),
  setCover: (id: string, name: string | null): Promise<void> => invoke('book_cover', { id, name }),
  remove: (id: string): Promise<string | null> => invoke('book_remove', { id })
}

const files = {
  list: (): Promise<Entry[]> => invoke('fs_list'),
  read: (path: string): Promise<string> => invoke('fs_read', { path }),
  write: (path: string, text: string): Promise<void> => invoke('fs_write', { path, text }),
  create: (folder: boolean, parent = ''): Promise<string> => invoke('fs_create', { folder, parent }),
  // Creates a note with its text and any missing folders; `path` is the topmost entry made.
  createNote: (path: string, text: string): Moved => invoke('fs_create_note', { path, text }),
  rename: (path: string, name: string): Moved => invoke('fs_rename', { path, name }),
  nest: (path: string): Moved => invoke('fs_nest', { path }),
  move: (path: string, dest: string): Moved => invoke('fs_move', { path, dest }),
  remove: (path: string): Promise<void> => invoke('fs_remove', { path })
}

// The book's AI chats, most recent first.
const chats = {
  list: (): Promise<{ id: string; title: string; ts: number }[]> => invoke('chat_list'),
  get: (id: string): Promise<Turn[] | null> => invoke('chat_get', { id }),
  save: (id: string, title: string, turns: Turn[]): Promise<void> => invoke('chat_save', { id, title, turns }),
  remove: (id: string): Promise<void> => invoke('chat_remove', { id })
}

// Builds the prompt from the book (outline, parent folder notes, the notes the chat points at, most
// recent first) and streams the reply as chunks.
async function generate(id: string, req: AiRequest): Promise<string | null> {
  try {
    const book = await books.current()
    if (!book) throw new Error('Window has no book')
    const read = async (p: string) => {
      const text = await files.read(p).catch(() => null)
      return text === null ? null : stripMarkers(text)
    }
    const parents = []
    for (const p of req.path ? parentNotes(req.path) : []) {
      const text = await read(p)
      if (text !== null) parents.push({ title: p.slice(p.lastIndexOf('/') + 1, -3), text })
    }
    const tree = await files.list()
    const pointed = [req.instruction, ...[...req.history].reverse()].flatMap((t) => (typeof t === 'string' ? mentioned(t, tree) : t.role === 'user' ? mentioned(t.text, tree) : (t.notes ?? [])))
    const notes = []
    for (const p of new Set(pointed)) {
      if (p === req.path) continue
      const text = await read(p)
      if (text !== null) notes.push({ path: p, text })
      if (notes.length === 6) break
    }
    const prompt = buildPrompt({ ...req, book: book.title, outline: outline(tree, req.path), parents, notes })
    return await invoke('ai_generate', { id, prompt, system: SYSTEM })
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

// Book images, embedded in notes as ![[name]]. Generating is cancelled with ai.cancel(id).
const images = {
  generate: (id: string, prompt: string, width: number, height: number, book?: string): Promise<{ name: string } | { error: string }> =>
    invoke('image_generate', { id, prompt, width, height, book }),
  url: (book: string, name: string) => convertFileSrc(`${book}/${name}`, 'img')
}

export const api = {
  books,
  files,
  images,
  settings: {
    get: (): Promise<Settings> => invoke('settings_get'),
    set: (s: Settings): Promise<Settings> => invoke('settings_set', { s })
  },
  ai: {
    generate,
    chats,
    cancel: (id: string): Promise<void> => invoke('ai_cancel', { id }),
    onChunk: (cb: (id: string, text: string) => void) => on('ai-chunk', ([id, text]) => cb(id, text)),
    detectClaude: (): Promise<string | null> => invoke('ai_detect_claude'),
    // Model ids a local or custom server offers; empty when it can't be reached.
    models: (provider: string): Promise<string[]> => invoke('ai_models', { provider }),
    // Tests a provider (the selected one by default) with the saved settings.
    test: (provider?: string): Promise<{ text: string } | { error: string }> => invoke('ai_test', { system: SYSTEM, provider })
  }
}

export type Api = typeof api

declare global {
  interface Window {
    api: Api
  }
}

window.api = api
