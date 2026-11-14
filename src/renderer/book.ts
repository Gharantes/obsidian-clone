import { EditorView, basicSetup } from 'codemirror'
import { EditorState, type StateEffect } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import type { Book, Entry } from './api.ts'
import { createAi } from './ai.ts'
import { createAssets, pickImage } from './assets.ts'
import { createDetails, type DetailsOpts } from './details.ts'
import { createExplorer, find, movePath } from './explorer.ts'
import { livePreview } from './livePreview.ts'
import { openSettings } from './settings.ts'
import { createTabBar, DETAILS_TAB, imageName, imageTab, loadTabs, nextTab, PAGE_TABS, saveTabs, TAGS_TAB } from './tabs.ts'
import { h, showMenu } from './ui.ts'

const { api } = window

// An open tab: a note, an image (see imageTab), one of the book's pages (PAGE_TABS), or empty
// (path null). While another tab is shown
// it keeps the note's editor state (with its undo history) and scroll position.
type Tab = { path: string | null; state?: EditorState; scroll?: StateEffect<unknown> }

type EditorOpts = {
  // Opens a note the AI points at.
  openNote(path: string, newTab: boolean): void
  // Called with the active tab's note whenever it changes.
  selected(path: string | null): void
  // Rereads the file tree after notes changed outside the explorer.
  refresh(): void
  // Shows the sidebar panel listing the tab's note or image (a Ctrl+click or Ctrl+Tab to it).
  reveal(path: string | null): void
  // Right-click on an image tab's image, by the image's path.
  imageMenu(ev: MouseEvent, path: string): void
  // For the Details tab's page.
  details: DetailsOpts
}

// Right-click in a note's text: Cut, Copy and Paste (it replaces the browser's own menu), and
// Insert image…, which embeds a picked image by its path in the Assets (![[Maps/Map.png]]) where
// the note was clicked.
function textMenu(book: string) {
  return EditorView.domEventHandlers({
    contextmenu(ev, view) {
      // Clicking outside the selection moves the cursor there, as in other editors.
      const pos = view.posAtCoords({ x: ev.clientX, y: ev.clientY })
      const sel = view.state.selection.main
      if (pos !== null && (pos < sel.from || pos > sel.to)) view.dispatch({ selection: { anchor: pos } })
      view.focus()
      const selected = !view.state.selection.main.empty
      const insert = (text: string) => {
        view.dispatch(view.state.replaceSelection(text))
        view.focus()
      }
      showMenu(ev, [
        ...(selected
          ? [
              { label: 'Cut', run: () => document.execCommand('cut') },
              { label: 'Copy', run: () => document.execCommand('copy') }
            ]
          : []),
        { label: 'Paste', run: () => navigator.clipboard.readText().then(insert, () => {}) },
        '-',
        {
          label: 'Insert image…',
          async run() {
            // Inserted after any selected text rather than over it.
            const end = view.state.selection.main.to
            const path = await pickImage(book, 'Insert image')
            if (!path || !view.dom.isConnected) return
            const at = Math.min(end, view.state.doc.length)
            const embed = `![[${path}]]`
            view.dispatch({ changes: { from: at, insert: embed }, selection: { anchor: at + embed.length } })
            view.focus()
          }
        }
      ])
      return true
    }
  })
}

// The open tabs and the active one's note in one editor. Edits autosave 500 ms after the last change, and when another note or tab is shown.
function createEditor(main: HTMLElement, pane: HTMLElement, crumbs: HTMLElement, book: string, o: EditorOpts) {
  let tabs: Tab[] = []
  let active: Tab | null = null
  // The note shown and saved; null while a tab is loading.
  let current: string | null = null
  let loads = 0
  let restored = false
  // What an image tab or the Tags tab shows, in place of the editor.
  let image: HTMLElement | null = null
  // The Details tab's page, in place of the editor.
  let details: ReturnType<typeof createDetails> | null = null
  let tree: Entry[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const save = () => {
    clearTimeout(timer)
    timer = undefined
    if (current) api.files.write(current, view.state.doc.toString())
  }
  const changed = () => {
    clearTimeout(timer)
    timer = setTimeout(save, 500)
  }
  const view = new EditorView({ parent: pane })
  const ai = createAi({
    view: () => (current ? view : null),
    path: () => current,
    tree: () => tree,
    open: (path) => o.openNote(path, false),
    refresh: () => o.refresh(),
    deleted: (path) => deleted(path)
  })
  const extensions = [
    basicSetup,
    markdown({ base: markdownLanguage }),
    livePreview({ url: (path) => api.images.url(book, path), open: (path) => open(imageTab(path), true) }),
    ai.extension,
    textMenu(book),
    EditorView.lineWrapping,
    EditorView.updateListener.of((u) => u.docChanged && changed())
  ]
  const bar = createTabBar({
    select(i, ctrl) {
      activate(tabs[i])
      if (ctrl) o.reveal(tabs[i].path)
    },
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

  // "Chapter 1 / Scene" for "Chapter 1/Scene.md", and an image as its path in the Assets
  // ("Maps / Map.png").
  const showCrumbs = () => {
    const path = active?.path ?? null
    const image = imageName(path)
    const parts = path && PAGE_TABS[path] ? [PAGE_TABS[path]] : image ? image.split('/') : path ? path.replace(/\.md$/, '').split('/') : []
    crumbs.replaceChildren(...parts.flatMap((p, i) => [...(i ? [h('span', { class: 'sep', textContent: '/' })] : []), h('span', { textContent: p })]))
  }

  // Saves the shown note and remembers where it was, before another note or tab is shown.
  function leave() {
    ai.settle()
    if (timer) save()
    if (active && current) Object.assign(active, { state: view.state, scroll: view.scrollSnapshot() })
    image?.remove()
    details?.destroy()
    image = details = null
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
    if (path === DETAILS_TAB) {
      view.dom.hidden = true
      const b = await api.books.current()
      if (n !== loads || !b) return
      details = createDetails(b, o.details)
      pane.append(details.el)
      return
    }
    if (path === TAGS_TAB) {
      image = h('div', { class: 'details-page' }, h('h2', { textContent: 'Tags' }), h('p', { class: 'muted', textContent: 'No tags yet.' }))
      pane.append(image)
      view.dom.hidden = true
      return
    }
    const imagePath = imageName(path)
    if (imagePath) {
      const img = h('img', { src: api.images.url(book, imagePath), alt: imagePath })
      img.oncontextmenu = (ev) => o.imageMenu(ev, imagePath)
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
    if (tab?.state && tab.state.doc.toString() === doc) {
      // Unchanged since the tab was last shown (it may have been edited in another tab).
      view.setState(tab.state)
      if (tab.scroll) view.dispatch({ effects: tab.scroll })
    } else view.setState(EditorState.create({ doc, extensions }))
    if (tab) tab.state = tab.scroll = undefined
    view.dom.hidden = false
    // Don't steal focus from the explorer's rename box when a new note opens.
    if (path && !(document.activeElement instanceof HTMLInputElement)) view.focus()
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
    Object.assign(active, { path, state: undefined, scroll: undefined })
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
    // Shows a page tab (see PAGE_TABS), opening it after the active tab if it isn't open.
    page(path: string) {
      const tab = tabs.find((t) => t.path === path)
      if (tab) activate(tab)
      else add(path)
    },
    // Shows a blank tab: the nearest open one to the right of the active tab, else a new one.
    blank() {
      const i = active ? tabs.indexOf(active) : -1
      const tab = [...tabs.slice(i + 1), ...tabs.slice(0, i + 1).reverse()].find((t) => !t.path)
      if (tab) activate(tab)
      else add(null)
    },
    closeTab: () => active && closeWhere((t) => t === active),
    // Shows the tab `by` places to the right (negative: left), wrapping around, and its panel in
    // the sidebar.
    cycle(by: number) {
      if (!active) return
      const n = tabs.length
      activate(tabs[(((tabs.indexOf(active) + by) % n) + n) % n])
      o.reveal(active.path)
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
      if (restored) return
      // Reopen last time's tabs once the tree shows which notes still exist.
      restored = true
      const saved = loadTabs(book)
      const all: Tab[] = saved.paths.map((path) => ({ path }))
      const missing = (tab: Tab) => !!tab.path && !PAGE_TABS[tab.path] && !imageName(tab.path) && !find(t, tab.path)
      active = nextTab(all, all[saved.active] ?? null, missing)
      tabs = all.filter((tab) => !missing(tab))
      load()
    }
  }
}

const icons = {
  details: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/><path d="M9 7h7M9 11h5"/></svg>',
  image: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/></svg>',
  characters: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  locations: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>',
  species: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="20" cy="16" r="2"/><path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z"/></svg>',
  items: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/></svg>',
  tags: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12.59 2.59A2 2 0 0 0 11.17 2H4a2 2 0 0 0-2 2v7.17a2 2 0 0 0 .59 1.42l8.7 8.7a2.43 2.43 0 0 0 3.42 0l6.58-6.58a2.43 2.43 0 0 0 0-3.42Z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>',
  extras: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M17.5 14v7M14 17.5h7"/></svg>',
  folder: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>'
}

// A view the sidebar can show, picked from the ribbon. `shown` runs each time it's shown. One with
// `page` instead of `el` is a button that opens one of the book's page tabs (see PAGE_TABS), not a
// sidebar view. An `optional` panel's button is only on the ribbon once turned on in the ribbon's
// extras menu.
type Panel = { id: string; title: string; icon: string; shown?: () => void; optional?: boolean } & ({ el: HTMLElement } | { page: string })

type RibbonOpts = {
  // Shows a page tab (by its path in PAGE_TABS).
  openPage(path: string): void
  // Moves off the page tab being shown, to a blank tab.
  leavePage(): void
}

// The ribbon: a narrow column of buttons, one per sidebar panel. A button shows its panel in the
// sidebar; clicking the shown panel's button again collapses the sidebar. Which panel is shown and
// which optional panels are on are remembered per book. While a page tab (Details, Tags) is shown
// the sidebar is hidden, leaving just the ribbon with that page's button lit; a panel button then
// moves to a blank tab first and shows its panel there.
function createRibbon(sidebar: HTMLElement, book: string, panels: Panel[], o: RibbonOpts) {
  const key = `sidebar:${book}`
  const extrasKey = `ribbon-extras:${book}`
  const on = new Set<string>()
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(extrasKey) ?? '[]')
    if (Array.isArray(saved)) saved.forEach((id) => typeof id === 'string' && on.add(id))
  } catch {}
  const available = (id: string | null) => panels.some((p) => p.id === id && (!p.optional || on.has(id)))
  const views = panels.flatMap((p) => ('el' in p ? [p] : []))
  let shown: string | null = panels[0].id
  try {
    const saved = localStorage.getItem(key)
    if (saved === '') shown = null // collapsed
    else if (available(saved) && views.some((p) => p.id === saved)) shown = saved
  } catch {}
  // The page panel whose tab is shown, if one is.
  let page: string | null = null
  const buttons = panels.map((p) => {
    const b = h('button', { class: 'icon', title: p.title, innerHTML: p.icon, hidden: !available(p.id) })
    b.onclick = () => pick(p)
    return b
  })
  const draw = () => {
    panels.forEach((p, i) => {
      if ('el' in p) p.el.hidden = p.id !== shown
      buttons[i].classList.toggle('on', p.id === (page ?? shown))
    })
    sidebar.hidden = !!page || !shown
  }
  const show = (id: string | null) => {
    shown = id
    draw()
    panels.find((p) => p.id === id)?.shown?.()
    try {
      localStorage.setItem(key, id ?? '')
    } catch {}
  }
  // A ribbon button was clicked (or its panel turned on).
  const pick = (p: Panel) => {
    if ('page' in p) return o.openPage(p.page)
    if (!page) return show(shown === p.id ? null : p.id)
    o.leavePage()
    show(p.id)
  }
  const toggle = (p: Panel, enabled: boolean) => {
    if (enabled) on.add(p.id)
    else on.delete(p.id)
    try {
      localStorage.setItem(extrasKey, JSON.stringify([...on]))
    } catch {}
    buttons[panels.indexOf(p)].hidden = !enabled
    if (enabled) pick(p)
    else if (shown === p.id) show(panels[0].id)
  }
  const extras = h('button', { class: 'icon extras', title: 'More in the ribbon', innerHTML: icons.extras })
  extras.onclick = (ev) =>
    showMenu(ev, panels.filter((p) => p.optional).map((p) => ({ label: p.title, checked: on.has(p.id), run: (c: boolean) => toggle(p, c) })))
  sidebar.append(...views.map((p) => p.el))
  show(shown)
  return {
    el: h('aside', { class: 'ribbon' }, ...buttons),
    // The button that opens the optional-panels menu; the caller places it.
    extras,
    // Shows the panel, leaving it open if it already is.
    reveal: (id: string) => shown !== id && show(id),
    // Called with the active tab's path whenever it changes: a page tab hides the sidebar and
    // lights its button; anything else brings the sidebar back.
    tab(path: string | null) {
      page = panels.find((p) => 'page' in p && p.page === path)?.id ?? null
      draw()
    }
  }
}

// An optional panel that has nothing in it yet.
function placeholderPanel(id: string, title: string, icon: string): Panel {
  const el = h('div', { class: 'panel extra' }, h('p', { class: 'empty-hint muted', textContent: `No ${title.toLowerCase()} yet.` }))
  return { id, title, icon, el, optional: true }
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
  const newFolder = h('button', { textContent: '+ Folder', title: 'New folder' })
  const main = h('main', { class: 'empty no-tabs' })

  const bookTitle = h('b', { textContent: book.title })
  const nav = h('nav', {}, h('div', { class: 'book-head' }, bookTitle))
  const assets = createAssets({
    open: (path, newTab) => editor.open(path, newTab),
    flush: () => editor.flush(),
    renamed(from, to) {
      editor.renamed(imageTab(from), imageTab(to))
      editor.reload() // its embeds may have changed
    },
    deleted: (paths) => paths.forEach((p) => editor.deleted(imageTab(p)))
  })
  const ribbon = createRibbon(nav, book.id, [
    { id: 'files', title: 'Files', icon: icons.folder, el: h('div', { class: 'panel' }, h('div', { class: 'actions' }, newNote, newFolder), tree) },
    { id: 'assets', title: 'Assets', icon: icons.image, el: assets.el, shown: assets.load },
    placeholderPanel('characters', 'Characters', icons.characters),
    placeholderPanel('locations', 'Locations', icons.locations),
    placeholderPanel('species', 'Species', icons.species),
    placeholderPanel('items', 'Items', icons.items),
    { id: 'tags', title: 'Tags', icon: icons.tags, optional: true, page: TAGS_TAB },
    { id: 'details', title: 'Details', icon: icons.details, page: DETAILS_TAB }
  ], {
    openPage: (path) => editor.page(path),
    leavePage: () => editor.blank()
  })
  ribbon.el.prepend(h('button', { class: 'icon', textContent: '←', title: 'Back to library', onclick: () => api.books.close() }))
  ribbon.el.append(
    ribbon.extras,
    h('button', { class: 'icon', textContent: '⚙', title: 'Settings', onclick: () => openSettings() })
  )
  root.replaceChildren(ribbon.el, nav, main)
  const editor = createEditor(main, pane, crumbs, book.id, {
    openNote: (path, newTab) => explorer.open(path, newTab),
    selected(path) {
      ribbon.tab(path)
      explorer.select(path)
      assets.select(path)
    },
    refresh: () => explorer.refresh(),
    reveal(path) {
      if (imageName(path)) ribbon.reveal('assets')
      else if (path?.endsWith('.md')) ribbon.reveal('files')
    },
    imageMenu: (ev, path) => assets.menu(ev, path),
    details: {
      renamed(title) {
        document.title = bookTitle.textContent = title
      },
      imagesChanged: () => assets.load()
    }
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
