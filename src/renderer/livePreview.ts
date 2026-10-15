import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

// Syntax marks to hide, keyed by node name, with the parent elements they are hidden in.
const HIDE: Record<string, (parent: string) => boolean> = {
  HeaderMark: (p) => p.startsWith('ATXHeading'),
  EmphasisMark: () => true,
  StrikethroughMark: () => true,
  CodeMark: (p) => p === 'InlineCode',
  QuoteMark: () => true
}

export type Span = { from: number; to: number; kind: 'hide' | 'quote' }

// Ranges to hide (and quote lines to style) between from and to, given the current selection.
export function previewSpans(state: EditorState, from = 0, to = state.doc.length): Span[] {
  const touched = (a: number, b: number) => state.selection.ranges.some((r) => r.from <= b && r.to >= a)
  const spans: Span[] = []
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (node.name === 'Blockquote') {
        for (let pos = node.from; pos <= node.to; ) {
          const line = state.doc.lineAt(pos)
          spans.push({ from: line.from, to: line.from, kind: 'quote' })
          pos = line.to + 1
        }
      }
      // Links show only their text: hide "[" and everything from "]" to the end.
      if (node.name === 'Link') {
        const marks = node.node.getChildren('LinkMark')
        if (marks.length >= 2 && !touched(node.from, node.to)) {
          spans.push({ from: marks[0].from, to: marks[0].to, kind: 'hide' })
          spans.push({ from: marks[1].from, to: node.to, kind: 'hide' })
        }
        return false
      }
      const parent = node.node.parent
      if (!parent || !HIDE[node.name]?.(parent.name) || touched(parent.from, parent.to)) return
      // Hide the space after "#" and ">" too.
      const spaced = (node.name === 'HeaderMark' || node.name === 'QuoteMark') && state.sliceDoc(node.to, node.to + 1) === ' '
      spans.push({ from: node.from, to: node.to + (spaced ? 1 : 0), kind: 'hide' })
    }
  })
  return spans
}

const hidden = Decoration.replace({})
const quoteLine = Decoration.line({ class: 'cm-lp-quote' })

function decorations(view: EditorView): DecorationSet {
  const { from } = view.visibleRanges[0] ?? { from: 0 }
  const { to } = view.visibleRanges.at(-1) ?? { to: 0 }
  const decos = previewSpans(view.state, from, to).map((s) =>
    (s.kind === 'hide' ? hidden : quoteLine).range(s.from, s.to)
  )
  return Decoration.set(decos, true)
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = decorations(view)
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.startState) !== syntaxTree(u.state))
        this.decorations = decorations(u.view)
    }
  },
  { decorations: (v) => v.decorations }
)

const style = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.8em', fontWeight: '700' },
  { tag: t.heading2, fontSize: '1.5em', fontWeight: '700' },
  { tag: t.heading3, fontSize: '1.3em', fontWeight: '600' },
  { tag: [t.heading4, t.heading5, t.heading6], fontSize: '1.1em', fontWeight: '600' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: '#7c4dff' },
  { tag: t.url, color: '#888' },
  { tag: t.monospace, fontFamily: 'monospace', backgroundColor: '#0000000d', borderRadius: '3px' },
  { tag: [t.processingInstruction, t.meta, t.quote], color: '#888' }
])

const theme = EditorView.theme({
  '.cm-content': { padding: '24px 32px', maxWidth: '760px', margin: '0 auto' },
  '.cm-lp-quote': { borderLeft: '3px solid #7c4dff', paddingLeft: '12px' }
})

// Obsidian-style Live Preview: Markdown renders inline, syntax shows only where the cursor is.
export const livePreview = () => [plugin, syntaxHighlighting(style), theme]
