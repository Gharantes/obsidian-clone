import { StateEffect, StateField, type Text } from '@codemirror/state'
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view'
import { parseReply, placeEdits, type Edit, type Turn } from './prompt.ts'
import { sourcePicker } from './settings.ts'
import { h } from './ui.ts'

// Text the AI just wrote stays highlighted until the next edit.
const setAdded = StateEffect.define<DecorationSet>()
const addedMark = Decoration.mark({ class: 'cm-ai-text' })
const added = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(d, tr) {
    for (const e of tr.effects) if (e.is(setAdded)) return e.value
    return tr.docChanged ? Decoration.none : d
  },
  provide: (f) => EditorView.decorations.from(f)
})

const listeners = new Map<string, (text: string) => void>()
window.api.ai.onChunk((id, text) => listeners.get(id)?.(text))

const IMAGE = /\{\{image:\s*([^}]*)\}\}/g

// AI chat sidebar for the editor (Ctrl/Cmd+J). Ask for anything; the AI answers and edits the note
// itself (one undo step, with an Undo button on its message). Drag the left edge to resize.
export function createAi(view: EditorView, getPath: () => string | null) {
  const history: Turn[] = []
  let job: string | null = null
  let stopped = false
  let undo: { after: Text; el: HTMLElement } | null = null

  const log = h('div', { class: 'messages' })
  const input = h('textarea', { placeholder: 'Ask AI to write or change anything in this note…' })
  const send = h('button', { class: 'primary', textContent: 'Send', title: 'Send (Enter)', onclick: () => run() })
  const stop = h('button', { textContent: 'Stop', hidden: true, onclick: () => job && ((stopped = true), window.api.ai.cancel(job)) })
  const close = h('button', { class: 'icon', textContent: '×', title: 'Close (Esc)', onclick: () => hide() })
  const clear = h('button', { class: 'icon', textContent: 'New chat', title: 'Start a new chat', onclick: () => reset() })
  const grip = h('div', { class: 'grip', title: 'Drag to resize' })
  const label = (text: string, control: HTMLElement) => h('label', {}, h('span', { textContent: text }), control)
  const panel = h('aside', { class: 'ai-panel', hidden: true },
    grip,
    h('header', {}, h('span', { class: 'spark', textContent: '✨' }), h('b', { textContent: 'AI' }), clear, close),
    log,
    input,
    h('footer', {}, label('Text', sourcePicker('ai')), label('Images', sourcePicker('image')), stop, send)
  )
  resizable(panel, grip)

  function message(role: Turn['role'], text: string) {
    const body = h('div', { textContent: text })
    const foot = h('div', { class: 'foot' })
    const el = log.appendChild(h('div', { class: `msg ${role}` }, body, foot))
    log.scrollTop = log.scrollHeight
    return { el, body, foot }
  }

  function reset() {
    if (job) return
    history.length = 0
    undo = null
    log.replaceChildren(h('p', { class: 'muted', textContent: 'Ask for anything, like "write an opening scene in the rain", "make the second paragraph tenser" or "add a picture of the castle".' }))
  }

  function setBusy(busy: boolean) {
    send.hidden = busy
    stop.hidden = !busy
    panel.dataset.state = busy ? 'running' : 'idle'
  }

  function show() {
    if (!getPath()) return
    panel.hidden = false
    input.focus()
  }
  function hide() {
    panel.hidden = true
    view.focus()
  }

  async function run() {
    const path = getPath()
    const instruction = input.value.trim()
    if (!path || job || !instruction) return
    input.value = ''
    message('user', instruction)
    const reply = message('assistant', '…')
    reply.el.classList.add('pending')
    const sel = view.state.selection.main
    const req = { instruction, history: [...history], path, doc: view.state.doc.toString(), from: sel.from, to: sel.to }
    history.push({ role: 'user', text: instruction })

    const id = (job = crypto.randomUUID())
    stopped = false
    setBusy(true)
    let raw = ''
    listeners.set(id, (text) => {
      raw += text
      const p = parseReply(raw)
      reply.body.textContent = p.reply || (p.edits.length || raw.includes('<edit>') ? 'Editing the note…' : '…')
      log.scrollTop = log.scrollHeight
    })
    const error = await window.api.ai.generate(id, req)
    listeners.delete(id)
    const p = parseReply(raw)
    const note = (text: string, cls = '') => reply.foot.append(h('span', { class: cls, textContent: text }))
    const live = () => job === id && !stopped
    if (live() && !error && p.edits.length) await drawImages(id, p.edits, live, (text) => (reply.body.textContent = text), note)
    reply.body.textContent = p.reply || (p.edits.length ? 'Done.' : stopped ? 'Stopped.' : error ? '' : 'The AI returned nothing.')
    if (error) note(error, 'error')
    if (job !== id) note('Stopped because you opened another note.')
    reply.el.classList.remove('pending')
    history.push({ role: 'assistant', text: p.reply || '(edited the note)' })
    if (job !== id) return // settled by switching notes
    job = null
    setBusy(false)
    if (!stopped && !error && p.edits.length && getPath() === path) apply(p.edits, reply.foot, note)
  }

  // Replaces each {{image: …}} with an embed of a generated picture, one at a time.
  async function drawImages(id: string, edits: Edit[], live: () => boolean, status: (text: string) => void, note: (text: string, cls?: string) => void) {
    for (const e of edits) {
      for (const [tag, prompt] of [...e.replace.matchAll(IMAGE)]) {
        if (!live()) return
        status('Drawing a picture…')
        const r = await window.api.images.generate(id, prompt.trim(), 1024, 768)
        e.replace = e.replace.replace(tag, 'name' in r ? `![[${r.name}]]` : '')
        if ('error' in r) note(`Picture not drawn: ${r.error}`, 'error')
      }
    }
  }

  function apply(edits: Edit[], foot: HTMLElement, note: (text: string, cls?: string) => void) {
    const sel = view.state.selection.main
    const { changes, failed } = placeEdits(view.state.doc.toString(), sel.from, sel.to, edits)
    if (failed) note(`Couldn't find where to make ${failed === 1 ? 'one change' : `${failed} changes`}.`, 'error')
    if (!changes.length) return
    const before = view.state.doc
    const set = view.state.changes(changes)
    const marks: ReturnType<typeof addedMark.range>[] = []
    set.iterChanges((_a, _b, from, to) => to > from && marks.push(addedMark.range(from, to)))
    view.dispatch({ changes: set, effects: setAdded.of(Decoration.set(marks)), scrollIntoView: true })
    view.dispatch({ effects: EditorView.scrollIntoView(marks[0]?.from ?? set.mapPos(sel.from), { y: 'center' }) })

    // Undo works while the note is as the AI left it; after that, Ctrl+Z in the note still does.
    const inverse = set.invert(before)
    const btn = h('button', { textContent: 'Undo', onclick: () => {
      if (view.state.doc === undo?.after) view.dispatch({ changes: inverse })
      btn.remove()
      undo = null
    } })
    undo?.el.remove()
    undo = { after: view.state.doc, el: btn }
    foot.append(btn)
  }

  input.onkeydown = (k) => {
    if (k.key === 'Enter' && !k.shiftKey) {
      k.preventDefault()
      run()
    }
    if (k.key === 'Escape') hide()
  }

  reset()
  return {
    panel,
    show,
    toggle: () => (panel.hidden ? show() : hide()),
    extension: [
      added,
      keymap.of([{ key: 'Mod-j', run: () => (show(), true) }]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && undo && u.state.doc !== undo.after) {
          undo.el.remove()
          undo = null
        }
      })
    ],
    // Called before another note is loaded: stop any generation. The chat carries over.
    settle() {
      if (job) window.api.ai.cancel(job)
      job = null
      undo?.el.remove()
      undo = null
      setBusy(false)
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
