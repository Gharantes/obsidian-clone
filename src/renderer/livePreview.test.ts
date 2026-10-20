import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { previewSpans } from './livePreview.ts'

// Text that stays visible, given the document and cursor position.
function visible(doc: string, cursor: number): string {
  const state = EditorState.create({ doc, selection: { anchor: cursor }, extensions: markdown({ base: markdownLanguage }) })
  let out = ''
  let pos = 0
  for (const s of previewSpans(state).filter((s) => s.kind === 'hide')) {
    out += doc.slice(pos, s.from)
    pos = s.to
  }
  return out + doc.slice(pos)
}

test('live preview hides syntax away from the cursor', () => {
  const doc = '# Title\n\nSome **bold**, *it*, ~~gone~~, `code` and [a link](http://x.io "t").\n\n> quoted\n\n<http://auto.io>'
  const end = doc.length
  assert.equal(
    visible(doc, end),
    'Title\n\nSome bold, it, gone, code and a link.\n\nquoted\n\n<http://auto.io>'
  )
  assert.ok(visible(doc, 2).startsWith('# Title'), 'cursor on heading shows #')
  assert.ok(visible(doc, doc.indexOf('bold') + 1).includes('**bold**'), 'cursor in bold shows **')
  assert.ok(visible(doc, doc.indexOf('bold') + 1).includes(' it,'), 'other elements stay hidden')
})

test('image embeds show as images away from the cursor', () => {
  const doc = 'See ![[AI image 1.jpg|cover]] and ![[notes.md]]'
  const spans = (cursor: number) => previewSpans(EditorState.create({ doc, selection: { anchor: cursor } })).filter((s) => s.kind === 'image')
  assert.deepEqual(spans(doc.length), [{ from: 4, to: 29, kind: 'image', name: 'AI image 1.jpg' }], 'only image files embed')
  assert.deepEqual(spans(10), [], 'cursor on the embed shows its text')
})
