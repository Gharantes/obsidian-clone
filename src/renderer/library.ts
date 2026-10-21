import type { Book } from './api.ts'
import { openSettings, sourcePicker } from './settings.ts'
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
  input.onkeydown = (k) => {
    if (k.key === 'Enter') create()
  }
  const body = h('div', { class: 'new-book' }, preview, h('div', {}, input, swatches, error))
  const dlg = modal('New book', [body], [
    h('button', { textContent: 'Cancel', onclick: () => dlg.close() }),
    h('button', { class: 'primary', textContent: 'Create', onclick: create })
  ])
  paint()
  input.focus()
}

// Asks for a description and draws a cover image for the book; resolves when done or cancelled.
function generateCover(b: Book): Promise<void> {
  return new Promise((resolve) => {
    const job = crypto.randomUUID()
    const input = h('input', { value: `Book cover illustration for "${b.title}", no text` })
    const source = sourcePicker('image')
    const status = h('p', { class: 'hint', textContent: 'Takes about 10 seconds.' })
    const draw = async () => {
      if (!input.value.trim()) return input.focus()
      go.disabled = input.disabled = source.disabled = true
      status.className = 'hint'
      status.textContent = 'Drawing…'
      const r = await api.images.generate(job, input.value.trim(), 768, 1024, b.id)
      go.disabled = input.disabled = source.disabled = false
      if ('error' in r) {
        status.className = 'error'
        status.textContent = r.error
        return
      }
      await api.books.setCover(b.id, r.name)
      dlg.close()
    }
    const go = h('button', { class: 'primary', textContent: 'Generate', onclick: draw })
    input.onkeydown = (k) => {
      if (k.key === 'Enter') draw()
    }
    const cancel = h('button', { textContent: 'Cancel', onclick: () => dlg.close() })
    const dlg = modal('Generate cover image', [input, h('label', { class: 'field' }, h('span', { textContent: 'Image source' }), source), status], [cancel, go], () => (api.ai.cancel(job), resolve()))
    input.focus()
    input.select()
  })
}

function card(b: Book, covers: string[], reload: () => void, report: (e: string | null) => void): HTMLElement {
  const cover = h('div', { class: 'cover' }, h('span', { textContent: b.title }))
  cover.style.setProperty('--cover', b.color)
  if (b.cover) {
    cover.classList.add('image')
    cover.style.setProperty('--image', `url("${api.images.url(b.id, b.cover)}")`)
  }
  const meta = `${b.notes} note${b.notes === 1 ? '' : 's'} · ${ago(b.ts)}`
  const el = h('div', { class: 'book', tabIndex: 0 }, cover, h('b', { textContent: b.title }), h('small', { textContent: meta }))
  const open = async () => report(await api.books.open(b.id))
  el.onclick = open
  el.onkeydown = (k) => {
    if (k.key === 'Enter') open()
  }

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
      { label: 'Generate cover image…', run: () => generateCover(b).then(reload) },
      ...(b.cover ? [{ label: 'Remove cover image', run: run(() => api.books.setCover(b.id, null)) }] : []),
      { label: 'Export as .zip…', run: run(() => api.books.export(b.id)) },
      '-',
      {
        label: 'Delete book',
        danger: true,
        run: run(async () => (confirm(`Delete "${b.title}" and all its notes? This can't be undone; export it first to keep a copy.`) ? api.books.remove(b.id) : null))
      }
    ])
  return el
}

// Main page: a grid of book covers, plus "New book" and "Import".
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
      h('button', {
        textContent: 'Import…',
        onclick: (ev: MouseEvent) =>
          showMenu(ev, [
            { label: 'Folder…', run: async () => report(await api.books.import(false)) },
            { label: '.zip file…', run: async () => report(await api.books.import(true)) }
          ])
      }),
      h('button', { class: 'icon', title: 'Settings', textContent: '⚙', onclick: () => openSettings() })
    ),
    error,
    grid
  )
  window.addEventListener('focus', reload)
  await reload()
}
