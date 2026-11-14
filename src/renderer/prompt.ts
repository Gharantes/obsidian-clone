import type { Entry } from './api.ts'

// `notes`: on the AI's turns, the notes that reply created or changed.
export type Turn = { role: 'user' | 'assistant'; text: string; notes?: string[] }

// What the sidebar sends: the request, the chat so far, and the open note (path null when none)
// with where the cursor/selection is.
export type AiRequest = { instruction: string; history: Turn[]; path: string | null; doc: string; from: number; to: number }

export type PromptInput = AiRequest & {
  book: string
  outline: string
  // Other notes the chat points at.
  notes: { path: string; text: string }[]
}

export const SYSTEM = `You are a writing assistant inside a Markdown notes app where people write books. You chat with the user about their book and change its notes when they ask: write new text, edit, rewrite, shorten, delete, create notes, anything.

Reply in this format:
<reply>A sentence or two for the user: what you did, or your answer if they only asked something.</reply>
Then one block per change:
<edit note="path/of/note.md"><find>exact text copied from that note</find><replace>the new text</replace></edit>
<create note="path/of/new note.md">the new note's text</create>

- Notes go by their path in the book outline. Leave out note="…" to edit the open note.
- <find> must match the note's text you were shown exactly and be unique there; keep it to the part that changes. If you weren't shown a note you need, ask the user to point at it with [[its name]].
- To add text, put the text it should follow in <find> and repeat it at the start of <replace>. An empty <find> inserts at <cursor/> or replaces the <selection> in the open note, and adds to the end of any other note.
- To delete text, leave <replace> empty.
- <create> makes a note that doesn't exist yet; missing folders in its path are made too. Folders only organize notes; they have no text of their own.
- To add a picture, put {{image: a detailed visual description}} on its own line in <replace> or <create>.
- Note text is Markdown, in the book's language unless asked otherwise. No preamble, no code fences.
- Make no changes when the user only asks a question.`

const head = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '\n[…]' : s)
const tail = (s: string, n: number) => (s.length > n ? '[…]\n' + s.slice(-n) : s)

// Indented list of the book's notes and folders by path, marking the open note.
export function outline(entries: Entry[], open: string | null, depth = 0): string {
  return entries
    .filter((e) => e.folder || e.name.endsWith('.md'))
    .map((e) => {
      const line = `${'  '.repeat(depth)}- ${e.path}${e.folder ? '/' : ''}${e.path === open ? ' (open)' : ''}`
      return e.folder ? [line, outline(e.children ?? [], open, depth + 1)].filter(Boolean).join('\n') : line
    })
    .join('\n')
}

// What a note is called in links: its path without ".md".
export const noteName = (path: string) => path.replace(/\.md$/, '')

// Every note in the book.
export function notePaths(entries: Entry[]): string[] {
  return entries.flatMap((e) => (e.folder ? notePaths(e.children ?? []) : e.name.endsWith('.md') ? [e.path] : []))
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Notes `text` points at: [[links]] by name or title, and titles written out ("Mira", not "Mirage").
export function mentioned(text: string, entries: Entry[]): string[] {
  const all = notePaths(entries).map((path) => ({ path, name: noteName(path).toLowerCase() }))
  const base = (name: string) => name.slice(name.lastIndexOf('/') + 1)
  const found = new Set<string>()
  for (const [, link] of text.matchAll(/\[\[([^\]|#\n]+)/g)) {
    const k = link.trim().replace(/\.md$/i, '').toLowerCase()
    const hit = all.find((n) => n.name === k) ?? all.find((n) => base(n.name) === k)
    if (hit) found.add(hit.path)
  }
  const prose = text.replace(/\[\[[^\]]*\]\]/g, ' ')
  for (const n of all) {
    const t = base(n.name)
    if (t.length >= 3 && new RegExp(`(^|[^\\p{L}\\p{N}])${escape(t)}($|[^\\p{L}\\p{N}])`, 'iu').test(prose)) found.add(n.path)
  }
  return [...found]
}

// The user message: book context, the notes pointed at, the open note with the cursor or selection
// marked, the chat, then the request.
export function buildPrompt(p: PromptInput): string {
  const parts = [`Book: "${p.book}"`]
  if (p.outline) parts.push(`Book outline:\n${head(p.outline, 6000)}`)
  for (const n of p.notes) parts.push(`Note "${n.path}":\n"""\n${head(n.text, 12000)}\n"""`)
  if (p.path) {
    const sel = p.to > p.from ? `<selection>${p.doc.slice(p.from, p.to)}</selection>` : '<cursor/>'
    const note = p.doc.length > 40000 ? `${tail(p.doc.slice(0, p.from), 30000)}${sel}${head(p.doc.slice(p.to), 10000)}` : p.doc.slice(0, p.from) + sel + p.doc.slice(p.to)
    parts.push(`Open note "${p.path}" (the user's cursor or selection is marked):\n"""\n${note}\n"""`)
  } else parts.push('No note is open.')
  const changed = (t: Turn) => (t.notes?.length ? ` (changed ${t.notes.join(', ')})` : '')
  if (p.history.length) parts.push(`Chat so far:\n${p.history.map((t) => `${t.role === 'user' ? 'User' : 'You'}: ${head(t.text, 2000)}${changed(t)}`).join('\n')}`)
  parts.push(`User: ${p.instruction}`)
  return parts.join('\n\n')
}

// `note`: the note to change (the open one when missing). `create`: a new note, with `replace` as its text.
export type Edit = { find: string; replace: string; note?: string; create?: boolean }

// One newline right inside a tag is formatting, not content.
const unwrap = (s: string) => s.replace(/^\r?\n/, '').replace(/\r?\n$/, '').replace(/<cursor\/>|<\/?selection>/g, '')

// "/Part 1/Scene" -> "Part 1/Scene.md"
const notePath = (s: string) => s.trim().replace(/^\/+/, '').replace(/(\.md)?$/, '.md')

export const CHANGE = /<(edit|create)\b/

// The reply text and the complete edit and create blocks in a (possibly still streaming) answer.
export function parseReply(raw: string): { reply: string; edits: Edit[] } {
  const reply = raw.match(/<reply>([\s\S]*?)(<\/reply>|$)/)?.[1] ?? (CHANGE.test(raw) ? '' : raw)
  const edits: Edit[] = []
  const blocks = /<edit\b([^>]*)>\s*<find>([\s\S]*?)<\/find>\s*<replace>([\s\S]*?)<\/replace>\s*<\/edit>|<create\b([^>]*)>([\s\S]*?)<\/create>/g
  for (const m of raw.matchAll(blocks)) {
    const note = (m[1] ?? m[4]).match(/note="([^"]+)"/)?.[1]
    if (m[2] !== undefined) edits.push({ find: unwrap(m[2]), replace: unwrap(m[3]), ...(note && { note: notePath(note) }) })
    else if (note) edits.push({ find: '', replace: unwrap(m[5]), note: notePath(note), create: true })
  }
  return { reply: reply.trim(), edits }
}

// What goes before text added to the end of a note that isn't open: a blank line.
export function endSeparator(doc: string): string {
  return !doc.trim() || doc.endsWith('\n\n') ? '' : doc.endsWith('\n') ? '\n' : '\n\n'
}

export type Change = { from: number; to: number; insert: string }

// Turns edits into non-overlapping changes to `doc`. An empty find means the cursor or selection;
// text found more than once uses the match nearest the cursor. Edits that can't be placed are counted.
export function placeEdits(doc: string, from: number, to: number, edits: Edit[]): { changes: Change[]; failed: number } {
  const changes: Change[] = []
  let failed = 0
  for (const e of edits) {
    let at = { from, to }
    if (e.find) {
      const find = doc.includes(e.find) ? e.find : e.find.trim()
      let best = -1
      for (let i = find ? doc.indexOf(find) : -1; i >= 0; i = doc.indexOf(find, i + 1)) if (best < 0 || Math.abs(i - from) < Math.abs(best - from)) best = i
      if (best < 0) {
        failed++
        continue
      }
      at = { from: best, to: best + find.length }
    }
    if (changes.some((c) => at.from < c.to && c.from < at.to)) {
      failed++
      continue
    }
    changes.push({ ...at, insert: e.replace })
  }
  return { changes: changes.sort((a, b) => a.from - b.from), failed }
}
