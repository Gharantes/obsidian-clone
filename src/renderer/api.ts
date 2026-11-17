import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { buildPrompt, mentioned, outline, SYSTEM, type AiRequest, type Turn } from './prompt.ts'

// Folders only organize notes: they carry `children` and have no text of their own.
export type Entry = { path: string; name: string; folder: boolean; children?: Entry[] }

// `cover` is the path of the book's cover image (see images), if it has one.
export type Book = { id: string; ts: number; title: string; notes: number; color: string; cover: string | null; summary: string; tags: Tag[]; section: string | null }

export type Tag = { name: string; color: string }

// A named group of books in the library; when `folded`, only its header shows in the library, and its covers don't load.
export type Section = { id: string; title: string; folded: boolean }

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
    // Pollinations is free with no key; Cloudflare Workers AI is free up to a daily allowance;
    // "openai" is any /images/generations server (stable-diffusion.cpp, LocalAI, ...).
    provider: 'pollinations' | 'cloudflare' | 'openai'
    openai: ApiConfig
    cloudflare: { accountId: string; apiToken: string }
  }
  pixiv: {
    // PHPSESSID cookie of a logged-in account, for R-18 works; empty downloads public works only.
    session: string
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
  // The window's book; null in the library.
  current: (): Promise<Book | null> => invoke('book_current'),
  rename: (id: string, title: string): Promise<string | null> => invoke('book_rename', { id, title }),
  setColor: (id: string, color: string): Promise<void> => invoke('book_color', { id, color }),
  setCover: (id: string, name: string | null): Promise<void> => invoke('book_cover', { id, name }),
  setSummary: (id: string, summary: string): Promise<void> => invoke('book_summary', { id, summary }),
  setTags: (id: string, tags: Tag[]): Promise<void> => invoke('book_tags', { id, tags }),
  // Puts the books in a section (null: the top of the library) in this order, first to last.
  reorder: (section: string | null, ids: string[]): Promise<void> => invoke('book_reorder', { section, ids }),
  remove: (id: string): Promise<string | null> => invoke('book_remove', { id })
}

// The library's sections, in order.
const sections = {
  list: (): Promise<Section[]> => invoke('section_list'),
  create: (title: string): Promise<string | null> => invoke('section_create', { title }),
  rename: (id: string, title: string): Promise<string | null> => invoke('section_rename', { id, title }),
  fold: (id: string, folded: boolean): Promise<void> => invoke('section_fold', { id, folded }),
  // Puts the sections in this order, first to last.
  reorder: (ids: string[]): Promise<void> => invoke('section_reorder', { ids }),
  // Its books go back to the top of the library.
  remove: (id: string): Promise<void> => invoke('section_remove', { id })
}

const files = {
  list: (): Promise<Entry[]> => invoke('fs_list'),
  read: (path: string): Promise<string> => invoke('fs_read', { path }),
  write: (path: string, text: string): Promise<void> => invoke('fs_write', { path, text }),
  create: (folder: boolean, parent = ''): Promise<string> => invoke('fs_create', { folder, parent }),
  // Creates a note with its text and any missing folders; `path` is the topmost entry made.
  createNote: (path: string, text: string): Moved => invoke('fs_create_note', { path, text }),
  rename: (path: string, name: string): Moved => invoke('fs_rename', { path, name }),
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

// Builds the prompt from the book (outline, the notes the chat points at, most recent first) and
// streams the reply as chunks.
async function generate(id: string, req: AiRequest): Promise<string | null> {
  try {
    const book = await books.current()
    if (!book) throw new Error('Window has no book')
    const tree = await files.list()
    const pointed = [req.instruction, ...[...req.history].reverse()].flatMap((t) => (typeof t === 'string' ? mentioned(t, tree) : t.role === 'user' ? mentioned(t.text, tree) : (t.notes ?? [])))
    const notes = []
    for (const p of new Set(pointed)) {
      if (p === req.path) continue
      const text = await files.read(p).catch(() => null)
      if (text !== null) notes.push({ path: p, text })
      if (notes.length === 6) break
    }
    const prompt = buildPrompt({ ...req, book: book.title, outline: outline(tree, req.path), notes })
    return await invoke('ai_generate', { id, prompt, system: SYSTEM })
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

// Book images, known by their path in the Assets folders ("Maps/Map.png", or "Map.png" at the top
// level) and embedded in notes as ![[path]]. Names are unique within a folder only; moving or
// renaming an image or folder updates the notes and cover that point at it.
const images = {
  // Into the top level. Cancelled with ai.cancel(id).
  generate: (id: string, prompt: string, width: number, height: number, book?: string): Promise<{ path: string } | { error: string }> =>
    invoke('image_generate', { id, prompt, width, height, book }),
  // `images` are [name, folder] pairs; '' is the top level.
  list: (): Promise<{ folders: string[]; images: [string, string][] }> => invoke('image_list'),
  // Asks for image files (and video files, unless `videos` is false) and copies them into the
  // folder, renaming any whose name the folder already has; `error` lists any that weren't added.
  // Videos live with the images, under the same calls.
  import: (folder: string, videos = true): Promise<{ paths: string[]; error: string | null }> => invoke('image_import', { folder, videos }),
  // Downloads a pixiv artwork's images (link or id) into folder/<artwork id>, skipping ones already
  // there; rejects with a message when nothing could be downloaded.
  importPixiv: (folder: string, link: string): Promise<{ paths: string[]; error: string | null }> => invoke('image_import_pixiv', { folder, link }),
  remove: (path: string): Promise<string | null> => invoke('image_remove', { path }),
  // Renamed "Map 1.png"... when the folder already has an image with its name.
  move: (path: string, folder: string): Moved => invoke('image_move', { path, folder }),
  // Folders only organize images; they hold no notes. Deleting one deletes its images and
  // resolves to their paths.
  folders: {
    create: (parent: string, name: string): Moved => invoke('image_folder_create', { parent, name }),
    move: (path: string, parent: string, name: string): Moved => invoke('image_folder_move', { path, parent, name }),
    remove: (path: string): Promise<string[]> => invoke('image_folder_remove', { path })
  },
  // Renames within its folder, keeping the extension when the new name has none.
  rename: (path: string, newName: string): Moved => invoke('image_rename', { path, newName }),
  // Asks where to save a copy; resolves to an error message, or null.
  save: (path: string): Promise<string | null> => invoke('image_save', { path }),
  url: (book: string, path: string) => convertFileSrc(`${book}/${path}`, 'img'),
  // A copy about 400px on its short side, for covers and tiles; made the first time it's shown.
  thumb: (book: string, path: string) => `${images.url(book, path)}?thumb`
}

export const api = {
  books,
  sections,
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
