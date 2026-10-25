import { Compartment, EditorState, StateEffect, StateField, Transaction } from '@codemirror/state'
import { Decoration, EditorView, keymap } from '@codemirror/view'
import type { Mode } from './prompt.ts'
import { sourcePicker } from './settings.ts'
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

// AI sidebar for the editor (Ctrl/Cmd+J). Drag its left edge to resize it. One button writes text:
// it rewrites the selection, writes what the prompt asks at the cursor, or with an empty prompt
// continues the note. Text streams into the note, then Keep (one undo step) or Discard.
// Image draws the typed description and embeds it at the cursor as ![[name]].
export function createAi(view: EditorView, getPath: () => string | null) {
  let state: State = 'idle'
  let job: string | null = null

  const input = h('textarea', { placeholder: '' })
  const status = h('span', { class: 'status' })
  const btn = (text: string, run: () => void, cls = '') => h('button', { textContent: text, className: cls, onclick: run })
  const b = {
    image: btn('🖼 Image', () => image()),
    write: btn('Write', () => start(), 'primary'),
    stop: btn('Stop', () => job && window.api.ai.cancel(job)),
    keep: btn('Keep', () => keep(), 'primary'),
    discard: btn('Discard', () => discard()),
    retry: btn('Retry', () => (discard(), start())),
    close: btn('×', () => hide(), 'icon')
  }
  const textSource = sourcePicker('ai')
  const imageSource = sourcePicker('image')
  const grip = h('div', { class: 'grip', title: 'Drag to resize' })
  const label = (text: string, control: HTMLElement) => h('label', {}, h('span', { textContent: text }), control)
  const panel = h('aside', { class: 'ai-panel', hidden: true },
    grip,
    h('header', {}, h('span', { class: 'spark', textContent: '✨' }), h('b', { textContent: 'AI' }), b.close),
    input,
    h('div', { class: 'sources' }, label('Text', textSource), label('Image', imageSource)),
    h('div', { class: 'actions' }, b.image, b.stop, b.discard, b.retry, b.write, b.keep),
    status
  )
  resizable(panel, grip)
  b.close.title = 'Close (Esc)'
  b.image.title = 'Generate an image of what you typed and insert it at the cursor'

  const hasSelection = () => !view.state.selection.main.empty
  const mode = (): Mode => (hasSelection() ? 'rewrite' : input.value.trim() ? 'write' : 'continue')
  const labels: Record<Mode, [string, string]> = {
    rewrite: ['Rewrite', 'Rewrite the selected text as the prompt says (Enter)'],
    write: ['Write', 'Write what the prompt asks at the cursor (Enter)'],
    continue: ['Continue', 'Continue the note from the cursor; type a prompt to ask for something specific (Enter)']
  }
  const updateWrite = () => ([b.write.textContent, b.write.title] = labels[mode()])
  const shown: Record<State, (keyof typeof b)[]> = {
    idle: ['image', 'write', 'close'],
    running: ['stop'],
    review: ['keep', 'discard', 'retry']
  }
  function setState(s: State, message = '', error = false) {
    state = s
    for (const [k, el] of Object.entries(b)) el.hidden = !shown[s].includes(k as keyof typeof b)
    b.image.hidden ||= hasSelection()
    updateWrite()
    input.placeholder = hasSelection()
      ? 'How should AI rewrite the selection?\n\nLeave empty to just improve the writing.'
      : 'What should AI write at the cursor?\n\nLeave empty to continue the note, or describe a picture and press Image.'
    input.disabled = textSource.disabled = imageSource.disabled = s !== 'idle'
    status.textContent = message
    status.classList.toggle('error', error)
    panel.dataset.state = s
  }

  function show() {
    if (!getPath()) return
    panel.hidden = false
    if (state === 'idle') setState('idle')
    if (state === 'review') b.keep.focus()
    else input.focus()
  }
  function hide() {
    if (state === 'running') return
    if (state === 'review') keep()
    panel.hidden = true
    view.focus()
  }

  async function start() {
    const path = getPath()
    if (!path || state === 'running') return
    if (state === 'review') keep()
    const sel = view.state.selection.main
    const m = mode()
    const instruction = input.value.trim()
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

  input.oninput = updateWrite
  input.onkeydown = (k) => {
    if (k.key === 'Enter' && !k.shiftKey) {
      k.preventDefault()
      start()
    }
    if (k.key === 'Escape') hide()
  }
  panel.onkeydown = (k) => {
    if (k.key === 'Escape' && state === 'review') discard()
  }

  setState('idle')
  return {
    panel,
    show,
    toggle: () => (panel.hidden ? show() : hide()),
    extension: [
      spans,
      lock.of([]),
      keymap.of([{ key: 'Mod-j', run: () => (show(), true) }]),
      EditorView.updateListener.of((u) => u.selectionSet && state === 'idle' && !panel.hidden && setState('idle', status.textContent ?? '', status.classList.contains('error')))
    ],
    // Called before another note is loaded: stop any generation and keep what was written.
    settle() {
      if (job) window.api.ai.cancel(job)
      job = null
      setState('idle')
    }
  }
}

// Dragging the grip sets the panel's width, which is remembered for next time.
function resizable(panel: HTMLElement, grip: HTMLElement) {
  const key = 'ai-panel-width'
  const setWidth = (w: number) => {
    const max = Math.max(260, window.innerWidth - 560) // leave room for the file tree and the note
    panel.style.width = `${Math.round(Math.min(Math.max(w, 260), max))}px`
  }
  try {
    const saved = Number(localStorage.getItem(key))
    if (saved) setWidth(saved)
  } catch {}
  grip.onpointerdown = (ev) => {
    ev.preventDefault()
    grip.setPointerCapture(ev.pointerId)
    const startX = ev.clientX
    const startW = panel.getBoundingClientRect().width
    panel.classList.add('resizing')
    grip.onpointermove = (m) => setWidth(startW + startX - m.clientX)
    grip.onpointerup = () => {
      grip.onpointermove = grip.onpointerup = null
      panel.classList.remove('resizing')
      try {
        localStorage.setItem(key, String(panel.getBoundingClientRect().width))
      } catch {}
    }
  }
  grip.ondblclick = () => {
    panel.style.width = ''
    try {
      localStorage.removeItem(key)
    } catch {}
  }
}
