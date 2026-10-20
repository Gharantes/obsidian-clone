import { EditorView, basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { createAi } from './ai.ts'
import { createExplorer, movePath } from './explorer.ts'
import { livePreview } from './livePreview.ts'
import { openSettings } from './settings.ts'
import { h } from './ui.ts'

const { api } = window

// One editor for the open note; edits autosave 500 ms after the last change.
function createEditor(pane: HTMLElement, crumbs: HTMLElement, book: string) {
  let current: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const save = () => {
    clearTimeout(timer)
    timer = undefined
    if (current) api.files.write(current, view.state.doc.toString())
  }
  const view = new EditorView({ parent: pane })
  const ai = createAi(view, () => current)
  pane.after(ai.bar)
  const extensions = [
    basicSetup,
    markdown({ base: markdownLanguage }),
    livePreview((name) => api.images.url(book, name)),
    ai.extension,
    EditorView.lineWrapping,
    EditorView.updateListener.of((u) => {
      if (!u.docChanged) return
      clearTimeout(timer)
      timer = setTimeout(save, 500)
    })
  ]

  // "Chapter 1 / Scene" for "Chapter 1/Scene.md"; a folder note shows as its folder.
  const showCrumbs = () => {
    const parts = current ? current.replace(/\.md$/, '').split('/') : []
    if (parts.length > 1 && parts.at(-1) === parts.at(-2)) parts.pop()
    crumbs.replaceChildren(...parts.flatMap((p, i) => [...(i ? [h('span', { class: 'sep', textContent: '/' })] : []), h('span', { textContent: p })]))
  }

  async function open(path: string | null) {
    ai.settle()
    if (timer) save()
    current = path
    view.setState(EditorState.create({ doc: path ? await api.files.read(path) : '', extensions }))
    pane.parentElement!.classList.toggle('empty', !path)
    showCrumbs()
    // Don't steal focus from the explorer's rename box when a new note opens.
    if (path && !(document.activeElement instanceof HTMLInputElement)) view.focus()
  }

  return {
    open,
    ai,
    renamed(from: string, to: string) {
      if (!current) return
      current = movePath(current, from, to)
      showCrumbs()
    },
    deleted(path: string) {
      if (!current || movePath(current, path, '') === current) return
      clearTimeout(timer)
      timer = undefined
      open(null)
    }
  }
}

// A book: file tree on the left, the open note on the right.
export function showBook(root: HTMLElement, book: { id: string; title: string }): void {
  document.title = book.title
  root.className = 'book-view'
  const tree = h('ul', { class: 'tree' })
  const crumbs = h('div', { class: 'crumbs' })
  const pane = h('div', { class: 'editor' })
  const aiButton = h('button', { class: 'ai-toggle', textContent: '✨ AI', title: 'Write with AI (Ctrl+J)' })
  const newNote = h('button', { textContent: '+ Note', title: 'New note' })
  const newFolder = h('button', { textContent: '+ Folder', title: 'New folder (with a folder note)' })

  root.replaceChildren(
    h('nav', {},
      h('div', { class: 'book-head' },
        h('button', { class: 'icon', textContent: '←', title: 'Back to library', onclick: () => api.books.close() }),
        h('b', { textContent: book.title })
      ),
      h('div', { class: 'actions' }, newNote, newFolder),
      tree,
      h('div', { class: 'nav-foot' }, h('button', { class: 'icon', textContent: '⚙', title: 'Settings', onclick: () => openSettings() }))
    ),
    h('main', { class: 'empty' },
      h('header', { class: 'note-head' }, crumbs, aiButton),
      pane,
      h('div', { class: 'placeholder' },
        h('p', { textContent: 'No note is open' }),
        h('p', { class: 'muted', textContent: 'Create a note, or right-click a note and choose "New note inside" to nest notes under it.' })
      )
    )
  )
  const editor = createEditor(pane, crumbs, book.id)
  const explorer = createExplorer(tree, editor)
  aiButton.onclick = () => editor.ai.toggle()
  newNote.onclick = () => explorer.create(false)
  newFolder.onclick = () => explorer.create(true)
}
