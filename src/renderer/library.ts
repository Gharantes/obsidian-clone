import type { Book } from '../preload/index.ts'
import { openSettings } from './settings.ts'
import { ago, ask, h, modal, showMenu } from './ui.ts'

const { api } = window

// Picks a cover color; resolves to the color or null when cancelled.
function pickCover(title: string, covers: string[], current?: string): Promise<string | null> {
  return new Promise((resolve) => {
    let chosen: string | null = null
    const swatches = h('div', { class: 'swatches' })
    for (const c of covers) {
      const b = h('button', { class: c === current ? 'on' : '', title: c, onclick: () => ((chosen = c), dlg.close()) })
      b.style.background = c
      swatches.append(b)
    }
    const dlg = modal(title, [swatches], [h('button', { textContent: 'Cancel', onclick: () => dlg.close() })], () => resolve(chosen))
  })
}

// New book dialog: title plus cover color; creating it opens the book.
async function newBook(covers: string[]): Promise<void> {
  let color = covers[Math.floor(Math.random() * covers.length)]
  const input = h('input', { placeholder: 'Book title' })
  const error = h('p', { class: 'error' })
  const preview = h('div', { class: 'cover small' }, h('span', { textContent: 'Untitled' }))
  const swatches = h('div', { class: 'swatches' })
  const paint = () => {
    preview.style.setProperty('--cover', color)
    preview.firstElementChild!.textContent = input.value.trim() || 'Untitled'
    swatches.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.title === color))
  }
  for (const c of covers) {
    const b = h('button', { title: c, onclick: () => ((color = c), paint()) })
    b.style.background = c
    swatches.append(b)
  }
  const create = async () => {
    if (!input.value.trim()) return input.focus()
    const err = await api.books.create(input.value, color)
    if (err) error.textContent = err
    // On success the window reloads into the new book.
  }
  input.oninput = paint
  input.onkeydown = (k) => k.key === 'Enter' && create()
  const body = h('div', { class: 'new-book' }, preview, h('div', {}, input, swatches, error))
  const dlg = modal('New book', [body], [
    h('button', { textContent: 'Cancel', onclick: () => dlg.close() }),
    h('button', { class: 'primary', textContent: 'Create', onclick: create })
  ])
  paint()
  input.focus()
}

function card(b: Book, covers: string[], reload: () => void, report: (e: string | null) => void): HTMLElement {
  const cover = h('div', { class: 'cover' }, h('span', { textContent: b.title }))
  cover.style.setProperty('--cover', b.color ?? covers[0])
  const meta = b.missing ? 'Folder missing' : `${b.notes} note${b.notes === 1 ? '' : 's'} · ${ago(b.ts)}`
  const el = h('div', { class: `book${b.missing ? ' missing' : ''}`, title: b.path, tabIndex: 0 }, cover, h('b', { textContent: b.title }), h('small', { textContent: meta }))
  const open = async () => report(await api.books.open(b.id))
  el.onclick = open
  el.onkeydown = (k) => k.key === 'Enter' && open()

  const run = (f: () => Promise<string | null | void>) => async () => {
    report((await f()) || null)
    reload()
  }
  el.oncontextmenu = (ev) =>
    showMenu(ev, [
      { label: 'Open', run: open },
      { label: 'Open in new window', run: run(() => api.books.open(b.id, true)) },
      '-',
      {
        label: 'Rename…',
        run: () =>
          ask('Rename book', { value: b.title, ok: 'Rename', check: (v) => api.books.rename(b.id, v) }).then(reload)
      },
      {
        label: 'Change cover…',
        run: run(async () => {
          const c = await pickCover('Cover color', covers, b.color)
          if (c) await api.books.setColor(b.id, c)
        })
      },
      { label: 'Show in file manager', run: () => api.books.reveal(b.id) },
      '-',
      { label: 'Remove from library', run: run(async () => (confirm(`Remove "${b.title}" from the library? Its files stay on disk.`) ? api.books.remove(b.id, false) : null)) },
      {
        label: 'Delete book',
        danger: true,
        run: run(async () => (confirm(`Delete "${b.title}"? Its folder will be moved to the system trash.`) ? api.books.remove(b.id, true) : null))
      }
    ])
  return el
}

// Main page: a grid of book covers, plus "New book" and "Open folder as book".
export async function showLibrary(root: HTMLElement): Promise<void> {
  document.title = 'Library'
  root.className = 'library'
  const covers = await api.books.covers()
  const grid = h('div', { class: 'grid' })
  const error = h('p', { class: 'error' })
  const search = h('input', { type: 'search', placeholder: 'Search books…' })
  const report = (msg: string | null) => (error.textContent = msg ?? '')
  let books: Book[] = []

  const render = () => {
    const q = search.value.trim().toLowerCase()
    const add = h('button', { class: 'book add', onclick: () => newBook(covers) }, h('div', { class: 'cover' }, h('span', { textContent: '+' })), h('b', { textContent: 'New book' }))
    const shown = books.filter((b) => b.title.toLowerCase().includes(q))
    grid.replaceChildren(...(q ? [] : [add]), ...shown.map((b) => card(b, covers, reload, report)))
    if (q && !shown.length) grid.append(h('p', { class: 'muted', textContent: 'No books match.' }))
  }
  const reload = async () => {
    books = await api.books.list()
    render()
  }
  search.oninput = render

  root.replaceChildren(
    h('header', {},
      h('h1', { textContent: 'Library' }),
      search,
      h('button', { textContent: 'Open folder as book', onclick: async () => report(await api.books.pick()) }),
      h('button', { class: 'icon', title: 'Settings', textContent: '⚙', onclick: () => openSettings() })
    ),
    error,
    grid
  )
  window.addEventListener('focus', reload)
  await reload()
}
