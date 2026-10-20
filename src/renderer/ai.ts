import { Compartment, EditorState, StateEffect, StateField, Transaction } from '@codemirror/state'
import { Decoration, EditorView, keymap } from '@codemirror/view'
import type { Mode } from './prompt.ts'
import { h } from './ui.ts'

// While a generation is shown: `orig` is the selected text being rewritten (empty when writing at
// the cursor) and `gen` the generated text streaming in right after it. The original stays in the
// note, struck through, until Keep replaces it; Discard just drops `gen`, so undo history is intact.
type Span = { from: number; to: number }
type Spans = { orig: Span; gen: Span }

const setSpans = StateEffect.define<Spans | null>()
const oldMark = Decoration.mark({ class: 'cm-ai-old' })
const newMark = Decoration.mark({ class: 'cm-ai-text' })
const spans = StateField.define<Spans | null>({
  create: () => null,
  update(s, tr) {
    for (const e of tr.effects) if (e.is(setSpans)) return e.value
    if (!s || !tr.docChanged) return s
    const map = (r: Span, grow: boolean) => ({ from: tr.changes.mapPos(r.from, -1), to: tr.changes.mapPos(r.to, grow ? 1 : -1) })
    return { orig: map(s.orig, false), gen: map(s.gen, true) }
  },
  provide: (f) =>
    EditorView.decorations.from(f, (s) => {
      if (!s) return Decoration.none
      const marks = []
      if (s.orig.to > s.orig.from) marks.push(oldMark.range(s.orig.from, s.orig.to))
      if (s.gen.to > s.gen.from) marks.push(newMark.range(s.gen.from, s.gen.to))
      return Decoration.set(marks)
    })
})
const lock = new Compartment()
const noHistory = Transaction.addToHistory.of(false)

const listeners = new Map<string, (text: string) => void>()
window.api.ai.onChunk((id, text) => listeners.get(id)?.(text))

type State = 'idle' | 'running' | 'review'

// AI writing bar for the editor (Ctrl/Cmd+J): write at the cursor, continue the note, or rewrite
// the selection. Text streams into the note, then Keep (one undo step) or Discard.
// Image draws the typed description and embeds it at the cursor as ![[name]].
export function createAi(view: EditorView, getPath: () => string | null) {
  let state: State = 'idle'
  let job: string | null = null
  let lastMode: Mode = 'write'

  const input = h('input', { placeholder: '' })
  const status = h('span', { class: 'status' })
  const btn = (text: string, run: () => void, cls = '') => h('button', { textContent: text, className: cls, onclick: run })
  const b = {
    continue: btn('Continue writing', () => start('continue')),
    image: btn('🖼 Image', () => image()),
    generate: btn('Generate', () => start('write'), 'primary'),
    stop: btn('Stop', () => job && window.api.ai.cancel(job)),
    keep: btn('Keep', () => keep(), 'primary'),
    discard: btn('Discard', () => discard()),
    retry: btn('Retry', () => (discard(), start(lastMode))),
    close: btn('×', () => hide(), 'icon')
  }
  const bar = h('div', { class: 'ai-bar', hidden: true }, h('span', { class: 'spark', textContent: '✨' }), input, status, ...Object.values(b))
  b.close.title = 'Close (Esc)'
  b.image.title = 'Generate an image of what you typed and insert it at the cursor'

  const hasSelection = () => !view.state.selection.main.empty
  const shown: Record<State, (keyof typeof b)[]> = {
    idle: ['continue', 'image', 'generate', 'close'],
    running: ['stop'],
    review: ['keep', 'discard', 'retry']
  }
  function setState(s: State, message = '', error = false) {
    state = s
    for (const [k, el] of Object.entries(b)) el.hidden = !shown[s].includes(k as keyof typeof b)
    b.continue.hidden ||= hasSelection()
    b.generate.textContent = hasSelection() ? 'Rewrite' : 'Generate'
    input.placeholder = hasSelection() ? 'How should AI rewrite the selection? (Enter)' : 'Tell AI what to write here… (Enter)'
    input.disabled = s !== 'idle'
    status.textContent = message
    status.classList.toggle('error', error)
    bar.dataset.state = s
  }

  function show() {
    if (!getPath()) return
    bar.hidden = false
    if (state === 'idle') setState('idle')
    if (state === 'review') b.keep.focus()
    else input.focus()
  }
  function hide() {
    if (state === 'running') return
    if (state === 'review') keep()
    bar.hidden = true
    view.focus()
  }

  async function start(mode: Mode) {
    const path = getPath()
    if (!path || state === 'running') return
    if (state === 'review') keep()
    const sel = view.state.selection.main
    const m: Mode = sel.empty ? mode : 'rewrite'
    const instruction = input.value.trim()
    if (m === 'write' && !instruction) return input.focus()
    lastMode = mode
    const req = { mode: m, instruction, path, doc: view.state.doc.toString(), from: sel.from, to: sel.to }

    // Generated text goes right after the selection; the note is locked while it streams in.
    view.dispatch({
      selection: { anchor: sel.to },
      effects: [setSpans.of({ orig: { from: sel.from, to: sel.to }, gen: { from: sel.to, to: sel.to } }), lock.reconfigure(EditorState.readOnly.of(true))]
    })
    const id = (job = crypto.randomUUID())
    setState('running', 'Writing…')
    listeners.set(id, (text) => {
      const s = view.state.field(spans, false)
      if (s) view.dispatch({ changes: { from: s.gen.to, insert: text }, annotations: noHistory, scrollIntoView: true })
    })
    const error = await window.api.ai.generate(id, req)
    listeners.delete(id)
    if (job !== id) return // settled by switching notes
    job = null
    view.dispatch({ effects: lock.reconfigure([]) })
    const s = view.state.field(spans, false)
    if (!s || s.gen.from === s.gen.to) {
      discard()
      return setState('idle', error ?? 'The AI returned no text.', true)
    }
    setState('review', error ?? '', !!error)
    b.keep.focus()
  }

  async function image() {
    const prompt = input.value.trim()
    if (!getPath() || state !== 'idle') return
    if (!prompt) return input.focus()
    const id = (job = crypto.randomUUID())
    setState('running', 'Drawing…')
    const r = await window.api.images.generate(id, prompt, 1024, 768)
    if (job !== id) return // settled by switching notes
    job = null
    if ('error' in r) return setState('idle', r.error, true)
    const at = view.state.selection.main.to
    // The cursor goes to the next line so the embed shows as the image.
    const text = `![[${r.name}]]\n`
    view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length } })
    input.value = ''
    setState('idle')
    view.focus()
  }

  // Re-applies the generated text as a single undoable change replacing the original.
  function keep() {
    const s = view.state.field(spans, false)
    if (s) {
      const text = view.state.sliceDoc(s.gen.from, s.gen.to)
      view.dispatch({ changes: { from: s.gen.from, to: s.gen.to }, annotations: noHistory })
      view.dispatch({ changes: { from: s.orig.from, to: s.orig.to, insert: text }, selection: { anchor: s.orig.from + text.length }, effects: setSpans.of(null) })
    }
    input.value = ''
    setState('idle')
    view.focus()
  }

  function discard() {
    const s = view.state.field(spans, false)
    if (s) view.dispatch({ changes: { from: s.gen.from, to: s.gen.to }, selection: { anchor: s.orig.from, head: s.orig.to }, effects: setSpans.of(null), annotations: noHistory })
    setState('idle')
    view.focus()
  }

  input.onkeydown = (k) => {
    if (k.key === 'Enter') start('write')
    if (k.key === 'Escape') hide()
  }
  bar.onkeydown = (k) => {
    if (k.key === 'Escape' && state === 'review') discard()
  }

  setState('idle')
  return {
    bar,
    show,
    toggle: () => (bar.hidden ? show() : hide()),
    extension: [
      spans,
      lock.of([]),
      keymap.of([{ key: 'Mod-j', run: () => (show(), true) }]),
      EditorView.updateListener.of((u) => u.selectionSet && state === 'idle' && !bar.hidden && setState('idle', status.textContent ?? '', status.classList.contains('error')))
    ],
    // Called before another note is loaded: stop any generation and keep what was written.
    settle() {
      if (job) window.api.ai.cancel(job)
      job = null
      setState('idle')
    }
  }
}
