// A folder's page is a list of sections, saved in its folder note with a marker line before each:
// "<!-- section: text -->" then the text, or "<!-- section: index -->" (a list of the folder's notes).
export type Section = { kind: 'text'; text: string } | { kind: 'index' }

const MARKER = /^<!-- section: (text|index) -->$/

// Text before the first marker, as in folder notes written before sections existed, is a text section.
export function parseSections(doc: string): Section[] {
  const sections: Section[] = []
  let lines: string[] | null = []
  let before = true // still before the first marker, where only non-blank text counts
  const flush = () => lines && !(before && !lines.join('').trim()) && sections.push({ kind: 'text', text: lines.join('\n') })
  for (const line of doc.split('\n')) {
    const m = line.match(MARKER)
    if (!m) {
      lines?.push(line)
      continue
    }
    flush()
    before = false
    lines = m[1] === 'text' ? [] : null
    if (m[1] === 'index') sections.push({ kind: 'index' })
  }
  flush()
  return sections
}

export function serializeSections(sections: Section[]): string {
  return sections.map((s) => `<!-- section: ${s.kind} -->${s.kind === 'text' ? '\n' + s.text : ''}`).join('\n')
}

// The note's text without section markers, for the AI.
export function stripMarkers(doc: string): string {
  return doc
    .split('\n')
    .filter((l) => !MARKER.test(l))
    .join('\n')
}

// "A/B/B.md" is the folder note of "A/B".
export function isFolderNote(path: string): boolean {
  const parts = path.split('/')
  return parts.length > 1 && parts.at(-1) === `${parts.at(-2)}.md`
}
