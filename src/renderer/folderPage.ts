import { EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { Entry } from './api.ts'
import { find, isNote, label } from './explorer.ts'
import { parseSections, serializeSections, type Section } from './sections.ts'
import { h, showMenu } from './ui.ts'

type Opts = {
  // Editor extensions for text sections (they save the page on change).
  extensions: Extension
  // Path of the folder, which can change while the page is open (renames).
  folder: () => string
  changed(): void
  open(path: string, newTab: boolean): void
}

type Block = { kind: Section['kind']; el: HTMLElement; view?: EditorView }

// Nested list of a folder's notes and subfolders; folders with a folder note open it.
// Ctrl/Cmd+click or middle-click opens one in a new tab.
function index(entries: Entry[], open: Opts['open']): HTMLElement {
  const items = entries.filter((e) => e.folder || isNote(e))
  return h('ul', {}, ...items.map((e) => {
    const target = e.folder ? e.note : e.path
    const name = target
      ? h('button', {
          textContent: label(e),
          onclick: (ev: MouseEvent) => open(target, ev.ctrlKey || ev.metaKey),
          onmousedown: (ev: MouseEvent) => ev.button === 1 && ev.preventDefault(),
          onauxclick: (ev: MouseEvent) => ev.button === 1 && open(target, true)
        })
      : h('span', { textContent: label(e) })
    return h('li', { class: e.folder ? 'folder' : '' }, name, ...(e.children?.length ? [index(e.children, open)] : []))
  }))
}

// A folder's page: text and index sections in order, with "Add section" at the end.
export function createFolderPage(doc: string, tree: Entry[], o: Opts) {
  const blocks: Block[] = []
  const list = h('div', { class: 'sections' })
  const empty = h('p', { class: 'muted', textContent: 'This folder has no sections yet.' })
  const add = h('button', {
    class: 'add-section',
    textContent: '+ Add section',
    onclick: (ev: MouseEvent) =>
      showMenu(ev, [
        { label: 'Text', run: () => insert({ kind: 'text', text: '' }, true) },
        { label: 'Index', run: () => insert({ kind: 'index' }, true) }
      ])
  })
  const el = h('div', { class: 'folder-page' }, list, empty, add)

  const sync = () => {
    list.replaceChildren(...blocks.map((b) => b.el))
    empty.hidden = blocks.length > 0
  }

  function fillIndex(b: Block) {
    const folder = find(tree, o.folder())
    const body = folder?.children?.some((e) => e.folder || isNote(e))
      ? index(folder.children, o.open)
      : h('p', { class: 'muted', textContent: 'No notes in this folder yet.' })
    b.el.querySelector('.index')!.replaceChildren(body)
  }

  function insert(s: Section, isNew = false) {
    const b: Block = { kind: s.kind, el: h('section', { class: s.kind }) }
    const move = (by: number) => {
      const i = blocks.indexOf(b)
      const j = i + by
      if (j < 0 || j >= blocks.length) return
      ;[blocks[i], blocks[j]] = [blocks[j], blocks[i]]
      sync()
      o.changed()
    }
    const remove = () => {
      if (b.view?.state.doc.length && !confirm('Delete this text section?')) return
      b.view?.destroy()
      blocks.splice(blocks.indexOf(b), 1)
      sync()
      o.changed()
    }
    b.el.append(h('div', { class: 'tools' },
      h('button', { class: 'icon', textContent: '↑', title: 'Move up', onclick: () => move(-1) }),
      h('button', { class: 'icon', textContent: '↓', title: 'Move down', onclick: () => move(1) }),
      h('button', { class: 'icon', textContent: '×', title: 'Delete section', onclick: remove })
    ))
    if (s.kind === 'text') {
      b.view = new EditorView({ parent: b.el, state: EditorState.create({ doc: s.text, extensions: o.extensions }) })
    } else {
      b.el.append(h('h3', { textContent: 'Index' }), h('div', { class: 'index' }))
      fillIndex(b)
    }
    blocks.push(b)
    sync()
    if (isNew) {
      o.changed()
      b.view?.focus()
      b.el.scrollIntoView({ block: 'nearest' })
    }
  }

  for (const s of parseSections(doc)) insert(s)

  return {
    el,
    text: () => serializeSections(blocks.map((b): Section => (b.view ? { kind: 'text', text: b.view.state.doc.toString() } : { kind: 'index' }))),
    // The first text section, for the AI to edit when none has been focused yet.
    firstView: () => blocks.find((b) => b.view)?.view ?? null,
    setTree(t: Entry[]) {
      tree = t
      for (const b of blocks) if (b.kind === 'index') fillIndex(b)
    },
    destroy() {
      for (const b of blocks) b.view?.destroy()
      el.remove()
    }
  }
}

export type FolderPage = ReturnType<typeof createFolderPage>
