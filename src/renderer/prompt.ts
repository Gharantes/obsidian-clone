import type { Entry } from './api.ts'

export type Mode = 'write' | 'continue' | 'rewrite'

// What the editor sends: the instruction, the note and where the cursor/selection is.
export type AiRequest = { mode: Mode; instruction: string; path: string; doc: string; from: number; to: number }

export type PromptInput = AiRequest & {
  book: string
  outline: string
  parents: { title: string; text: string }[]
}

export const SYSTEM =
  'You are a writing assistant inside a Markdown notes app where people write books. ' +
  'Reply with only the text to put into the note, written in Markdown. ' +
  'No preamble, no explanations, no surrounding quotes or code fences. ' +
  'Write in the same language as the note unless asked otherwise.'

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

// The user message: book context, the note with the cursor or selection marked, then the task.
export function buildPrompt(p: PromptInput): string {
  const before = tail(p.doc.slice(0, p.from), 12000)
  const after = head(p.doc.slice(p.to), 4000)
  const marked =
    p.mode === 'rewrite' ? `${before}<selection>${p.doc.slice(p.from, p.to)}</selection>${after}` : `${before}<cursor/>${after}`
  const task = {
    write: `Write the text to insert at <cursor/>. Instruction: ${p.instruction}`,
    continue:
      'Continue writing from <cursor/>, matching the voice, tense and style of the text so far. ' +
      'Write a few paragraphs at most and stop at a natural point.' +
      (p.instruction ? ` Guidance: ${p.instruction}` : ''),
    rewrite: `Rewrite the text inside <selection>. Instruction: ${p.instruction || 'Improve the writing.'} Reply with only the replacement text.`
  }[p.mode]

  const parts = [`Book: "${p.book}"`]
  if (p.outline) parts.push(`Book outline:\n${head(p.outline, 4000)}`)
  for (const n of p.parents) if (n.text.trim()) parts.push(`Parent note "${n.title}":\n"""\n${head(n.text, 3000)}\n"""`)
  parts.push(`Current note "${title(p.path)}":\n"""\n${marked}\n"""`)
  parts.push(
    `Task: ${task}\nStart exactly at the marked position: begin with a space or newline only if the text needs one there. Do not repeat the surrounding text.`
  )
  return parts.join('\n\n')
}
