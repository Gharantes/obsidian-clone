import { StateEffect, StateField, type ChangeSet, type Text } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import type { Entry } from './api.ts'
import { find } from './explorer.ts'
import { CHANGE, endSeparator, notePaths, noteName, parseReply, placeEdits, type Edit, type Turn } from './prompt.ts'
import { imagePicker, textPickers } from './settings.ts'
import { ago, h } from './ui.ts'

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

type Hooks = {
  // The editor the AI changes in place: the open note's. Null when no note is open.
  view(): EditorView | null
  // The open note.
  path(): string | null
  tree(): Entry[]
  open(path: string): void
  // Called after the AI changed or created notes in their files.
  refresh(): void
  // Called when Undo removes a note or folder the AI created.
  deleted(path: string): void
}

// A note the AI changed in its file (`before` null: created it, along with the folders up to `top`).
type FileChange = { path: string; before: string | null; after: string; top?: string }

// What a reply's Undo button reverts, each part only while it's as the AI left it.
type Undo = { el: HTMLElement; view?: { view: EditorView; after: Text; inverse: ChangeSet }; files: FileChange[] }

type Note = (text: string, cls?: string) => void

// AI chat sidebar (Ctrl/Cmd+J), with or without a note open. Ask for anything; the AI answers and
// changes the open note in place, or other notes and new ones by their path in the book. Point at
// notes with [[links]] or their titles so it sees them. Each reply that changes something gets an
// Undo button. Chats are saved with the book and can be reopened from History. Drag the left edge
// to resize.
export function createAi(o: Hooks) {
  const { chats } = window.api.ai
  const files = window.api.files
  const history: Turn[] = []
  let chatId: string | null = null
  let job: string | null = null
  let stopped = false
  let undo: Undo | null = null

  const log = h('div', { class: 'messages' })
  const input = h('textarea', { placeholder: 'Ask AI to write or change anything. Type [[ to point at a note…' })
  const suggest = h('div', { class: 'suggest', hidden: true })
  const send = h('button', { class: 'primary', textContent: 'Send', title: 'Send (Enter)', onclick: () => run() })
  const stop = h('button', { textContent: 'Stop', hidden: true, onclick: () => job && ((stopped = true), window.api.ai.cancel(job)) })
  const close = h('button', { class: 'icon', textContent: '×', title: 'Close (Esc)', onclick: () => hide() })
  const clear = h('button', { class: 'icon', textContent: 'New chat', title: 'Start a new chat', onclick: () => reset() })
  const past = h('button', { class: 'icon', textContent: 'History', title: 'Reopen a previous chat', onclick: () => (list.hidden ? showList() : hideList()) })
  const list = h('div', { class: 'chats', hidden: true })
  const grip = h('div', { class: 'grip', title: 'Drag to resize' })
  const label = (text: string, ...controls: HTMLElement[]) => h('label', {}, h('span', { textContent: text }), ...controls)
  const panel = h('aside', { class: 'ai-panel', hidden: true },
    grip,
    h('header', {}, h('span', { class: 'spark', textContent: '✨' }), h('b', { textContent: 'AI' }), past, clear, close),
    log,
    list,
    suggest,
    input,
    h('footer', {}, label('Text', ...textPickers()), label('Images', imagePicker()), stop, send)
  )
  resizable(panel, grip)

  function message(role: Turn['role'], text: string) {
    const body = h('div', { textContent: text })
    const foot = h('div', { class: 'foot' })
    const el = log.appendChild(h('div', { class: `msg ${role}` }, body, foot))
    log.scrollTop = log.scrollHeight
    return { el, body, foot }
  }

  // A button under a reply that opens a note it changed.
  const chip = (foot: HTMLElement, path: string, verb = '') =>
    foot.append(h('button', { class: 'note-link', textContent: `${verb}${noteName(path)}`, title: 'Open note', onclick: () => o.open(path) }))

  // Shows a chat: a new empty one, or saved messages.
  function load(id: string | null, turns: Turn[]) {
    chatId = id
    history.splice(0, history.length, ...turns)
    dropUndo()
    log.replaceChildren()
    if (!turns.length) log.append(h('p', { class: 'muted', textContent: 'Ask for anything, like "write an opening scene in the rain", "make the second paragraph of [[Mira]] tenser" or "create a note Chapter 2/Arrival with an outline".' }))
    for (const t of turns) {
      const m = message(t.role, t.text)
      for (const n of t.notes ?? []) chip(m.foot, n)
    }
    hideList()
  }
  function reset() {
    if (!job) load(null, [])
  }

  async function showList() {
    const all = await chats.list()
    list.replaceChildren(...(all.length ? [] : [h('p', { class: 'muted', textContent: 'No saved chats yet.' })]))
    for (const c of all) {
      const row = h('div', { class: `chat${c.id === chatId ? ' active' : ''}` },
        h('button', { onclick: async () => !job && load(c.id, (await chats.get(c.id)) ?? []) }, h('span', { textContent: c.title }), h('small', { textContent: ago(c.ts) })),
        h('button', { class: 'icon', textContent: '×', title: 'Delete chat', onclick: async () => {
          await chats.remove(c.id)
          if (c.id === chatId) chatId = null // keeps the messages on screen; the next one saves them as a new chat
          row.remove()
        } })
      )
      list.append(row)
    }
    log.hidden = true
    list.hidden = false
    past.classList.add('on')
  }
  function hideList() {
    list.hidden = true
    log.hidden = false
    past.classList.remove('on')
  }

  const save = () => {
    chatId ??= crypto.randomUUID()
    return chats.save(chatId, history[0].text.slice(0, 80), history)
  }

  function setBusy(busy: boolean) {
    send.hidden = busy
    stop.hidden = !busy
    panel.dataset.state = busy ? 'running' : 'idle'
  }

  function show() {
    panel.hidden = false
    input.focus()
  }
  function hide() {
    panel.hidden = true
    closeSuggest()
    o.view()?.focus()
  }

  // Typing [[ suggests notes; Enter or Tab (or a click) completes the link.
  let picks: string[] = []
  let pick = 0
  function suggestNotes() {
    const m = input.value.slice(0, input.selectionStart).match(/\[\[([^\]\n]*)$/)
    const q = m?.[1].toLowerCase()
    picks = q === undefined ? [] : notePaths(o.tree()).filter((p) => noteName(p).toLowerCase().includes(q)).slice(0, 8)
    pick = 0
    drawSuggest()
  }
  function drawSuggest() {
    suggest.hidden = !picks.length
    suggest.replaceChildren(...picks.map((p, i) => h('button', { class: i === pick ? 'on' : '', textContent: noteName(p), onmousedown: (ev: MouseEvent) => (ev.preventDefault(), complete(p)) })))
  }
  function closeSuggest() {
    picks = []
    drawSuggest()
  }
  function complete(path: string) {
    const at = input.selectionStart
    const start = input.value.lastIndexOf('[[', at - 1)
    const end = input.value.startsWith(']]', at) ? at + 2 : at
    input.setRangeText(`[[${noteName(path)}]]`, start, end, 'end')
    closeSuggest()
    input.focus()
  }

  async function run() {
    const instruction = input.value.trim()
    if (job || !instruction) return
    const path = o.path()
    const view = o.view()
    const open = view ? path : null
    hideList()
    closeSuggest()
    if (!history.length) log.replaceChildren()
    input.value = ''
    message('user', instruction)
    const reply = message('assistant', '…')
    reply.el.classList.add('pending')
    const sel = view?.state.selection.main
    const req = { instruction, history: [...history], path: open, doc: view?.state.doc.toString() ?? '', from: sel?.from ?? 0, to: sel?.to ?? 0 }
    history.push({ role: 'user', text: instruction })

    const id = (job = crypto.randomUUID())
    stopped = false
    setBusy(true)
    let raw = ''
    listeners.set(id, (text) => {
      raw += text
      const p = parseReply(raw)
      reply.body.textContent = p.reply || (p.edits.length || CHANGE.test(raw) ? 'Changing notes…' : '…')
      log.scrollTop = log.scrollHeight
    })
    const error = await window.api.ai.generate(id, req)
    listeners.delete(id)
    const p = parseReply(raw)
    const note: Note = (text, cls = '') => reply.foot.append(h('span', { class: cls, textContent: text }))
    const live = () => job === id && !stopped
    if (live() && !error && p.edits.length) await drawImages(id, p.edits, live, (text) => (reply.body.textContent = text), note)
    reply.body.textContent = p.reply || (p.edits.length ? 'Done.' : stopped ? 'Stopped.' : error ? '' : 'The AI returned nothing.')
    if (error) note(error, 'error')
    if (job !== id) note('Stopped because you opened another note.')
    reply.el.classList.remove('pending')
    const turn: Turn = { role: 'assistant', text: p.reply || '(changed notes)' }
    history.push(turn)
    if (job === id) {
      job = null
      setBusy(false)
      if (!stopped && !error && p.edits.length) {
        const notes = await apply(open, view, p.edits, reply.foot, note)
        if (notes.length) turn.notes = notes
      }
    }
    save()
  }

  // Replaces each {{image: …}} with an embed of a generated picture, one at a time.
  async function drawImages(id: string, edits: Edit[], live: () => boolean, status: (text: string) => void, note: Note) {
    for (const e of edits) {
      for (const [tag, prompt] of [...e.replace.matchAll(IMAGE)]) {
        if (!live()) return
        status('Drawing a picture…')
        const r = await window.api.images.generate(id, prompt.trim(), 1024, 768)
        e.replace = e.replace.replace(tag, 'path' in r ? `![[${r.path}]]` : '')
        if ('error' in r) note(`Picture not drawn: ${r.error}`, 'error')
      }
    }
  }

  // Makes a reply's changes: new notes, the open note's edits in its editor, other notes' in their
  // files. Returns the notes created or changed.
  async function apply(open: string | null, view: EditorView | null, edits: Edit[], foot: HTMLElement, note: Note): Promise<string[]> {
    const done = new Map<string, string>()
    const changed: FileChange[] = []
    let inView: Undo['view']
    let failed = 0
    for (const e of edits.filter((e) => e.create)) {
      const r = await files.createNote(e.note!, e.replace)
      if ('error' in r) note(`Couldn't create ${noteName(e.note!)}: ${r.error}`, 'error')
      else {
        changed.push({ path: e.note!, before: null, after: e.replace, top: r.path })
        done.set(e.note!, 'Created ')
      }
    }
    const byNote = new Map<string, Edit[]>()
    for (const e of edits.filter((e) => !e.create)) {
      const target = e.note ?? open
      if (target) byNote.set(target, [...(byNote.get(target) ?? []), e])
      else failed++
    }
    for (const [path, list] of byNote) {
      if (path === o.path()) {
        if (!view || path !== open || !view.dom.isConnected) failed += list.length
        else {
          const r = applyInView(view, list)
          failed += r.failed
          if (r.undo) (inView = r.undo), done.set(path, 'Edited ')
        }
        continue
      }
      const before = await files.read(path).catch(() => null)
      if (before === null) {
        failed += list.length
        continue
      }
      const sep = endSeparator(before)
      const r = placeEdits(before, before.length, before.length, list.map((e) => (e.find ? e : { ...e, replace: sep + e.replace })))
      failed += r.failed
      if (!r.changes.length) continue
      const after = r.changes.reduceRight((s, c) => s.slice(0, c.from) + c.insert + s.slice(c.to), before)
      await files.write(path, after)
      changed.push({ path, before, after })
      done.set(path, 'Edited ')
    }
    if (failed) note(`Couldn't find where to make ${failed === 1 ? 'one change' : `${failed} changes`}.`, 'error')
    for (const [path, verb] of done) chip(foot, path, verb)
    if (changed.length) o.refresh()
    if (inView || changed.length) setUndo(foot, inView, changed)
    return [...done.keys()]
  }

  function applyInView(view: EditorView, edits: Edit[]): { failed: number; undo?: Undo['view'] } {
    const sel = view.state.selection.main
    const { changes, failed } = placeEdits(view.state.doc.toString(), sel.from, sel.to, edits)
    if (!changes.length) return { failed }
    const before = view.state.doc
    const set = view.state.changes(changes)
    const marks: ReturnType<typeof addedMark.range>[] = []
    set.iterChanges((_a, _b, from, to) => to > from && marks.push(addedMark.range(from, to)))
    view.dispatch({ changes: set, effects: setAdded.of(Decoration.set(marks)), scrollIntoView: true })
    view.dispatch({ effects: EditorView.scrollIntoView(marks[0]?.from ?? set.mapPos(sel.from), { y: 'center' }) })
    return { failed, undo: { view, after: view.state.doc, inverse: set.invert(before) } }
  }

  // Ctrl+Z in the open note still undoes the AI's edit there after the button has gone.
  function setUndo(foot: HTMLElement, inView: Undo['view'], changed: FileChange[]) {
    dropUndo()
    const u: Undo = { view: inView, files: changed, el: h('button', { textContent: 'Undo', onclick: async () => {
      dropUndo()
      if (u.view && u.view.view.state.doc === u.view.after) u.view.view.dispatch({ changes: u.view.inverse })
      for (const f of u.files) await revert(f)
      if (u.files.length) o.refresh()
    } }) }
    undo = u
    foot.append(u.el)
  }
  function dropUndo() {
    undo?.el.remove()
    undo = null
  }
  // The open note's part of Undo goes once that note is edited or closed.
  function dropInView() {
    if (!undo) return
    undo.view = undefined
    if (!undo.files.length) dropUndo()
  }

  async function revert(f: FileChange) {
    if ((await files.read(f.path).catch(() => null)) !== f.after) return
    if (f.before !== null) return files.write(f.path, f.before)
    // A created note goes with the folders made for it, unless they've been given other notes since.
    const top = f.top ? find(o.tree(), f.top) : undefined
    const others = top?.folder ? notePaths([top]).filter((p) => p !== f.path) : []
    const gone = top?.folder && !others.length ? top.path : f.path
    await files.remove(gone)
    o.deleted(gone)
  }

  input.oninput = suggestNotes
  input.onblur = closeSuggest
  input.onkeydown = (k) => {
    if (picks.length) {
      if (k.key === 'ArrowDown' || k.key === 'ArrowUp') pick = (pick + (k.key === 'ArrowDown' ? 1 : picks.length - 1)) % picks.length
      else if (k.key === 'Enter' || k.key === 'Tab') complete(picks[pick])
      else if (k.key === 'Escape') closeSuggest()
      else return
      k.preventDefault()
      return drawSuggest()
    }
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
      EditorView.updateListener.of((u) => {
        if (u.docChanged && undo?.view?.view === u.view && u.state.doc !== undo.view.after) dropInView()
      })
    ],
    // Called before another note is loaded: stop any generation. The chat carries over.
    settle() {
      if (job) window.api.ai.cancel(job)
      job = null
      dropInView()
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
