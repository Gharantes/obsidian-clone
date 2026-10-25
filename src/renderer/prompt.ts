import type { Entry } from './api.ts'

export type Turn = { role: 'user' | 'assistant'; text: string }

// What the editor sends: the request, the chat so far, the note and where the cursor/selection is.
export type AiRequest = { instruction: string; history: Turn[]; path: string; doc: string; from: number; to: number }

export type PromptInput = AiRequest & {
  book: string
  outline: string
  parents: { title: string; text: string }[]
}

export const SYSTEM = `You are a writing assistant inside a Markdown notes app where people write books. You chat with the user about the note they have open and change it when they ask: write new text, edit, rewrite, shorten, delete, anything.

Reply in this format:
<reply>A sentence or two for the user: what you did, or your answer if they only asked something.</reply>
Then one block per change to the note:
<edit><find>exact text copied from the note</find><replace>the new text</replace></edit>

- <find> must match the note exactly and be unique there; keep it to the part that changes.
- To add text, put the text it should follow in <find> and repeat it at the start of <replace>. An empty <find> inserts at <cursor/>, or replaces the <selection>.
- To delete text, leave <replace> empty.
- To add a picture, put {{image: a detailed visual description}} on its own line in <replace>.
- Note text is Markdown, in the note's language unless asked otherwise. No preamble, no code fences.
- Make no edits when the user only asks a question.`

const title = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '')
const head = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '\n[…]' : s)
const tail = (s: string, n: number) => (s.length > n ? '[…]\n' + s.slice(-n) : s)

// Indented list of the book's notes, marking the current one.
export function outline(entries: Entry[], current: string, depth = 0): string {
  return entries
    .filter((e) => e.folder || e.name.endsWith('.md'))
    .map((e) => {
      const here = e.path === current || e.note === current ? ' (current note)' : ''
      const line = `${'  '.repeat(depth)}- ${title(e.path)}${here}`
      return e.folder ? [line, outline(e.children ?? [], current, depth + 1)].filter(Boolean).join('\n') : line
    })
    .join('\n')
}

// Folder notes above a note, outermost first: "A/B/C.md" -> ["A/A.md", "A/B/B.md"].
// A folder note's own folder is not its parent: "A/B/B.md" -> ["A/A.md"].
export function parentNotes(path: string): string[] {
  const parts = path.split('/').slice(0, -1)
  if (parts.length && `${parts.at(-1)}.md` === path.split('/').at(-1)) parts.pop()
  return parts.map((_, i) => `${parts.slice(0, i + 1).join('/')}/${parts[i]}.md`)
}

// The user message: book context, the note with the cursor or selection marked, the chat, then the request.
export function buildPrompt(p: PromptInput): string {
  const sel = p.to > p.from ? `<selection>${p.doc.slice(p.from, p.to)}</selection>` : '<cursor/>'
  const note = p.doc.length > 40000 ? `${tail(p.doc.slice(0, p.from), 30000)}${sel}${head(p.doc.slice(p.to), 10000)}` : p.doc.slice(0, p.from) + sel + p.doc.slice(p.to)

  const parts = [`Book: "${p.book}"`]
  if (p.outline) parts.push(`Book outline:\n${head(p.outline, 4000)}`)
  for (const n of p.parents) if (n.text.trim()) parts.push(`Parent note "${n.title}":\n"""\n${head(n.text, 3000)}\n"""`)
  parts.push(`Current note "${title(p.path)}" (the user's cursor or selection is marked):\n"""\n${note}\n"""`)
  if (p.history.length) parts.push(`Chat so far:\n${p.history.map((t) => `${t.role === 'user' ? 'User' : 'You'}: ${head(t.text, 2000)}`).join('\n')}`)
  parts.push(`User: ${p.instruction}`)
  return parts.join('\n\n')
}

export type Edit = { find: string; replace: string }

// One newline right inside a tag is formatting, not content.
const unwrap = (s: string) => s.replace(/^\r?\n/, '').replace(/\r?\n$/, '').replace(/<cursor\/>|<\/?selection>/g, '')

// The reply text and the complete edit blocks in a (possibly still streaming) answer.
export function parseReply(raw: string): { reply: string; edits: Edit[] } {
  const reply = raw.match(/<reply>([\s\S]*?)(<\/reply>|$)/)?.[1] ?? (raw.includes('<edit>') ? '' : raw)
  const edits = [...raw.matchAll(/<edit>\s*<find>([\s\S]*?)<\/find>\s*<replace>([\s\S]*?)<\/replace>\s*<\/edit>/g)].map((m) => ({
    find: unwrap(m[1]),
    replace: unwrap(m[2])
  }))
  return { reply: reply.trim(), edits }
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
