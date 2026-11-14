import { EditorView, basicSetup } from 'codemirror'
import { EditorState, type StateEffect } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import type { Book, Entry } from './api.ts'
import { createAi } from './ai.ts'
import { createAssets } from './assets.ts'
import { createDetails } from './details.ts'
import { createExplorer, find, movePath, parentOf } from './explorer.ts'
import { createFolderPage, type FolderPage } from './folderPage.ts'
import { livePreview } from './livePreview.ts'
import { isFolderNote } from './sections.ts'
import { openSettings } from './settings.ts'
import { createTabBar, imageName, imageTab, loadTabs, nextTab, saveTabs } from './tabs.ts'
import { h } from './ui.ts'

const { api } = window

// An open tab: a note, an image (see imageTab), or empty (path null). While another tab is shown
// it keeps the note's editor state (with its undo history) and scroll position.
type Tab = { path: string | null; state?: EditorState; scroll?: StateEffect<unknown>; pageScroll?: number }

type EditorOpts = {
  // Opens a note picked on a folder page.
  openNote(path: string, newTab: boolean): void
  // Called with the active tab's note whenever it changes.
  selected(path: string | null): void
  // Rereads the file tree after notes changed outside the explorer.
  refresh(): void
  // Right-click on an image tab's image.
  imageMenu(ev: MouseEvent, name: string): void
}

// The open tabs and the active one's note: one editor, or for a folder note the folder's page of
// sections. Edits autosave 500 ms after the last change, and when another note or tab is shown.
function createEditor(main: HTMLElement, pane: HTMLElement, crumbs: HTMLElement, book: string, o: EditorOpts) {
  let tabs: Tab[] = []
  let active: Tab | null = null
  // The note shown and saved; null while a tab is loading.
  let current: string | null = null
  let loads = 0
  let restored = false
  let page: FolderPage | null = null
  // The image an image tab shows, in place of the editor.
  let image: HTMLElement | null = null
  let tree: Entry[] = []
  // The editor the AI changes: the note, or the folder page's last focused text section.
  let focused: EditorView | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const save = () => {
    clearTimeout(timer)
    timer = undefined
    if (current) api.files.write(current, page ? page.text() : view.state.doc.toString())
  }
  const changed = () => {
    clearTimeout(timer)
    timer = setTimeout(save, 500)
  }
  const view = new EditorView({ parent: pane })
  const ai = createAi({
    view: () => (page ? (focused?.dom.isConnected ? focused : page.firstView()) : current ? view : null),
    path: () => current,
    tree: () => tree,
    open: (path) => o.openNote(path, false),
    refresh: () => o.refresh(),
    deleted: (path) => deleted(path)
  })
  const extensions = [
    basicSetup,
    markdown({ base: markdownLanguage }),
    livePreview({ url: (name) => api.images.url(book, name), open: (name) => open(imageTab(name), true) }),
    ai.extension,
    EditorView.lineWrapping,
    EditorView.updateListener.of((u) => {
      if (u.focusChanged && u.view.hasFocus) focused = u.view
      if (u.docChanged) changed()
    })
  ]
  const bar = createTabBar({
    select: (i) => activate(tabs[i]),
    close: (i) => closeWhere((t) => t === tabs[i]),
    closeOthers: (i) => closeWhere((t) => t !== tabs[i]),
    closeAll: () => closeWhere(() => true),
    move(from, to) {
      tabs.splice(to, 0, ...tabs.splice(from, 1))
      redraw()
    },
    add: () => add(null)
  })

  const redraw = () => {
    const i = active ? tabs.indexOf(active) : -1
    bar.draw(tabs.map((t) => t.path), i)
    main.classList.toggle('no-tabs', !tabs.length)
    saveTabs(book, tabs.map((t) => t.path), i)
  }

  // "Chapter 1 / Scene" for "Chapter 1/Scene.md"; a folder note shows as its folder.
  const showCrumbs = () => {
    const name = imageName(active?.path ?? null)
    const parts = name ? [name] : active?.path ? active.path.replace(/\.md$/, '').split('/') : []
    if (parts.length > 1 && parts.at(-1) === parts.at(-2)) parts.pop()
    crumbs.replaceChildren(...parts.flatMap((p, i) => [...(i ? [h('span', { class: 'sep', textContent: '/' })] : []), h('span', { textContent: p })]))
  }

  // Saves the shown note and remembers where it was, before another note or tab is shown.
  function leave() {
    ai.settle()
    if (timer) save()
    if (active && current) {
      if (page) active.pageScroll = page.el.scrollTop
      else Object.assign(active, { state: view.state, scroll: view.scrollSnapshot() })
    }
    page?.destroy()
    image?.remove()
    page = focused = image = null
    current = null
  }

  // Shows the active tab's note.
  async function load() {
    const tab = active
    const path = tab?.path ?? null
    redraw()
    showCrumbs()
    o.selected(path)
    main.classList.toggle('empty', !path)
    const n = ++loads
    const name = imageName(path)
    if (name) {
      const img = h('img', { src: api.images.url(book, name), alt: name })
      img.oncontextmenu = (ev) => o.imageMenu(ev, name)
      image = h('div', { class: 'image-view' }, img)
      pane.append(image)
      view.dom.hidden = true
      return
    }
    const doc = path ? await api.files.read(path).catch(() => null) : ''
    if (n !== loads) return
    if (doc === null) {
      tab!.path = null // the note is gone
      return load()
    }
    current = path
    if (path && isFolderNote(path)) {
      page = createFolderPage(doc, tree, { extensions, folder: () => parentOf(current!), changed, open: o.openNote })
      pane.append(page.el)
      view.setState(EditorState.create({ extensions }))
      page.el.scrollTop = tab!.pageScroll ?? 0
    } else if (tab?.state && tab.state.doc.toString() === doc) {
      // Unchanged since the tab was last shown (it may have been edited in another tab).
      view.setState(tab.state)
      if (tab.scroll) view.dispatch({ effects: tab.scroll })
    } else view.setState(EditorState.create({ doc, extensions }))
    if (tab) tab.state = tab.scroll = tab.pageScroll = undefined
    view.dom.hidden = !!page
    // Don't steal focus from the explorer's rename box when a new note opens.
    if (path && !page && !(document.activeElement instanceof HTMLInputElement)) view.focus()
  }

  function activate(tab: Tab | null) {
    if (tab === active) return
    leave()
    active = tab
    load()
  }

  // Adds a tab after the active one and shows it.
  function add(path: string | null) {
    const tab: Tab = { path }
    tabs.splice(active ? tabs.indexOf(active) + 1 : tabs.length, 0, tab)
    activate(tab)
  }

  // Opens a note in the active tab, or in a new one.
  function open(path: string, newTab = false) {
    if (newTab || !active) return add(path)
    if (active.path === path) return
    leave()
    Object.assign(active, { path, state: undefined, scroll: undefined, pageScroll: undefined })
    load()
  }

  function closeWhere(drop: (t: Tab) => boolean) {
    const next = nextTab(tabs, active, drop)
    tabs = tabs.filter((t) => !drop(t))
    if (next === active) redraw()
    else activate(next)
  }

  // Closes the tabs showing the deleted note or folder, without saving them.
  function deleted(path: string) {
    const gone = (t: Tab) => !!t.path && movePath(t.path, path, '') !== t.path
    if (active && gone(active)) {
      clearTimeout(timer)
      timer = undefined
    }
    closeWhere(gone)
  }

  return {
    open,
    ai,
    bar: bar.el,
    newTab: () => add(null),
    closeTab: () => active && closeWhere((t) => t === active),
    // Shows the tab `by` places to the right (negative: left), wrapping around.
    cycle(by: number) {
      if (!active) return
      const n = tabs.length
      activate(tabs[(((tabs.indexOf(active) + by) % n) + n) % n])
    },
    renamed(from: string, to: string) {
      for (const t of tabs) if (t.path) t.path = movePath(t.path, from, to)
      if (current) current = movePath(current, from, to)
      redraw()
      showCrumbs()
    },
    deleted,
    // Saves pending edits now, before notes are changed behind the editor's back.
    flush: () => timer && save(),
    // Rereads the active tab's note (or image) after it changed behind the editor's back.
    reload() {
      leave()
      load()
    },
    listed(t: Entry[]) {
      tree = t
      page?.setTree(t)
      if (restored) return
      // Reopen last time's tabs once the tree shows which notes still exist.
      restored = true
      const saved = loadTabs(book)
      const all: Tab[] = saved.paths.map((path) => ({ path }))
      const missing = (tab: Tab) => !!tab.path && !imageName(tab.path) && !find(t, tab.path)
      active = nextTab(all, all[saved.active] ?? null, missing)
      tabs = all.filter((tab) => !missing(tab))
      load()
    }
  }
}

const icons = {
  details: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/><path d="M9 7h7M9 11h5"/></svg>',
  image: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/></svg>',
  folder: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>'
}

// A view the sidebar can show, picked from the ribbon. `shown` runs each time it's shown.
type Panel = { id: string; title: string; icon: string; el: HTMLElement; shown?: () => void }

// The ribbon: a narrow column of buttons, one per sidebar panel. A button shows its panel in the
// sidebar; clicking the shown panel's button again collapses the sidebar. Remembered per book.
function createRibbon(sidebar: HTMLElement, book: string, panels: Panel[]): HTMLElement {
  const key = `sidebar:${book}`
  let shown: string | null = panels[0].id
  try {
    const saved = localStorage.getItem(key)
    if (saved === '') shown = null // collapsed
    else if (panels.some((p) => p.id === saved)) shown = saved
  } catch {}
  const buttons = panels.map((p) => {
    const b = h('button', { class: 'icon', title: p.title, innerHTML: p.icon })
    b.onclick = () => show(shown === p.id ? null : p.id)
    return b
  })
  const show = (id: string | null) => {
    shown = id
    panels.forEach((p, i) => {
      p.el.hidden = p.id !== id
      buttons[i].classList.toggle('on', p.id === id)
    })
    sidebar.hidden = !id
    panels.find((p) => p.id === id)?.shown?.()
    try {
      localStorage.setItem(key, id ?? '')
    } catch {}
  }
  sidebar.append(...panels.map((p) => p.el))
  show(shown)
  return h('aside', { class: 'ribbon' }, ...buttons)
}

// A book: ribbon and sidebar (file tree) on the left, tabs of open notes on the right.
export function showBook(root: HTMLElement, book: Book): void {
  document.title = book.title
  root.className = 'book-view'
  const tree = h('ul', { class: 'tree' })
  const crumbs = h('div', { class: 'crumbs' })
  const pane = h('div', { class: 'editor' })
  const aiButton = h('button', { class: 'ai-toggle', textContent: '✨ AI', title: 'Write with AI (Ctrl+J)' })
  const newNote = h('button', { textContent: '+ Note', title: 'New note' })
  const newFolder = h('button', { textContent: '+ Folder', title: 'New folder (opens as a page of sections)' })
  const main = h('main', { class: 'empty no-tabs' })

  const bookTitle = h('b', { textContent: book.title })
  const nav = h('nav', {},
    h('div', { class: 'book-head' },
      h('button', { class: 'icon', textContent: '←', title: 'Back to library', onclick: () => api.books.close() }),
      bookTitle
    )
  )
  const assets = createAssets({
    open: (path, newTab) => editor.open(path, newTab),
    flush: () => editor.flush(),
    renamed(from, to) {
      editor.renamed(imageTab(from), imageTab(to))
      editor.reload() // its embeds may have changed
    },
    deleted: (names) => names.forEach((n) => editor.deleted(imageTab(n)))
  })
  const details = createDetails(book, {
    renamed(title) {
      document.title = bookTitle.textContent = title
    },
    imagesChanged: () => assets.load()
  })
  const ribbon = createRibbon(nav, book.id, [
    { id: 'files', title: 'Files', icon: icons.folder, el: h('div', { class: 'panel' }, h('div', { class: 'actions' }, newNote, newFolder), tree) },
    { id: 'assets', title: 'Assets', icon: icons.image, el: assets.el, shown: assets.load },
    { id: 'details', title: 'Details', icon: icons.details, el: details.el, shown: details.shown }
  ])
  ribbon.append(h('button', { class: 'icon settings', textContent: '⚙', title: 'Settings', onclick: () => openSettings() }))
  root.replaceChildren(ribbon, nav, main)
  const editor = createEditor(main, pane, crumbs, book.id, {
    openNote: (path, newTab) => explorer.open(path, newTab),
    selected(path) {
      explorer.select(path)
      assets.select(path)
    },
    refresh: () => explorer.refresh(),
    imageMenu: (ev, name) => assets.menu(ev, name)
  })
  main.append(
    editor.bar,
    h('header', { class: 'note-head' }, crumbs, aiButton),
    pane,
    h('div', { class: 'placeholder' },
      h('p', { textContent: 'No note is open' }),
      h('p', { class: 'muted', textContent: 'Pick a note on the left. Ctrl+click or middle-click one to open it in a new tab.' }),
      h('div', { class: 'links' },
        h('button', { textContent: 'Create new note', onclick: () => explorer.create(false) }),
        h('button', { textContent: '✨ Ask AI', title: 'Create or change notes with AI (Ctrl+J)', onclick: () => editor.ai.show() }),
        h('button', { class: 'close-tab', textContent: 'Close tab', onclick: () => editor.closeTab() })
      )
    )
  )
  root.append(editor.ai.panel)
  const explorer = createExplorer(tree, editor)
  aiButton.onclick = () => editor.ai.toggle()
  newNote.onclick = () => explorer.create(false)
  newFolder.onclick = () => explorer.create(true)

  // Ctrl+J the AI sidebar, Ctrl+T new tab, Ctrl+W close it, Ctrl+Tab / Ctrl+PageDown next tab (with
  // Shift / PageUp: previous).
  document.addEventListener('keydown', (k) => {
    const mod = (k.ctrlKey || k.metaKey) && !k.altKey
    const key = k.key.toLowerCase()
    if (mod && !k.shiftKey && key === 'j') editor.ai.toggle()
    else if (mod && !k.shiftKey && key === 't') editor.newTab()
    else if (mod && !k.shiftKey && key === 'w') editor.closeTab()
    else if (k.ctrlKey && key === 'tab') editor.cycle(k.shiftKey ? -1 : 1)
    else if (k.ctrlKey && (key === 'pagedown' || key === 'pageup')) editor.cycle(key === 'pagedown' ? 1 : -1)
    else return
    k.preventDefault()
  })
}
