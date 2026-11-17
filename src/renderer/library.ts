import type { Book, Section } from './api.ts'
import { openSettings, imagePicker } from './settings.ts'
import { ago, ask, h, modal, showMenu } from './ui.ts'

const { api } = window

// Picks a cover color; resolves to the color or null when cancelled.
export function pickCover(title: string, covers: string[], current?: string): Promise<string | null> {
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
export function generateCover(b: { id: string; title: string }): Promise<void> {
  return new Promise((resolve) => {
    const job = crypto.randomUUID()
    const input = h('input', { value: `Book cover illustration for "${b.title}", no text` })
    const source = imagePicker()
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
      await api.books.setCover(b.id, r.path)
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
    cover.style.setProperty('--image', `url("${api.images.thumb(b.id, b.cover)}")`)
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

// Main page: the books at the top, then each section's books, as grids of covers. Drag a book to
// reorder it or move it into another section, and a section's header to move the section; click
// the header to fold it. Plus "New book", "New section" and "Import".
export async function showLibrary(root: HTMLElement): Promise<void> {
  document.title = 'Library'
  root.className = 'library'
  const covers = await api.books.covers()
  const shelves = h('div', { class: 'shelves' })
  const error = h('p', { class: 'error' })
  const search = h('input', { type: 'search', placeholder: 'Search books…' })
  const report = (msg: string | null) => (error.textContent = msg ?? '')
  let books: Book[] = []
  let sections: Section[] = []

  // Dragging moves the book or section among the others as it goes; dropping saves where it
  // landed, Esc puts it back. It follows the pointer by hand rather than with the browser's drag
  // and drop, which blocks the scroll wheel; holding it near the top or bottom of the page scrolls
  // too. Reordering needs everything on show, so it's off while searching.
  // `el` is what moves, `handle` what was grabbed (and what the ghost under the pointer copies);
  // `place` moves `el` to where the pointer is, `drop` saves (or, when not `save`, undoes) it.
  let dragged: HTMLElement | null = null
  const follow = (down: PointerEvent, el: HTMLElement, handle: HTMLElement, place: (x: number, y: number) => void, drop: (save: boolean) => unknown) => {
    if (down.button !== 0 || dragged) return
    const r = handle.getBoundingClientRect()
    const dx = down.clientX - r.left
    const dy = down.clientY - r.top
    let x = down.clientX
    let y = down.clientY
    let ghost: HTMLElement | null = null
    let frame = 0

    // Scrolls while the pointer is held near the top or bottom edge, faster nearer the edge.
    const edgeScroll = () => {
      const box = root.getBoundingClientRect()
      const edge = 70
      const speed = y < box.top + edge ? -(box.top + edge - y) : y > box.bottom - edge ? y - (box.bottom - edge) : 0
      if (speed) root.scrollTop += Math.min(Math.max(speed, -edge), edge) / 3
      frame = requestAnimationFrame(edgeScroll)
    }
    const start = () => {
      dragged = el
      ghost = handle.cloneNode(true) as HTMLElement
      ghost.classList.add('ghost')
      ghost.removeAttribute('data-id')
      ghost.style.width = `${r.width}px`
      document.body.append(ghost)
      el.classList.add('dragging')
      root.classList.add('grabbing')
      frame = requestAnimationFrame(edgeScroll)
    }
    const move = (ev: PointerEvent) => {
      x = ev.clientX
      y = ev.clientY
      if (!dragged) {
        if (Math.hypot(x - down.clientX, y - down.clientY) < 6) return
        start()
      }
      ghost!.style.transform = `translate(${x - dx}px, ${y - dy}px)`
      place(x, y)
    }
    // The wheel scrolls the page under a still pointer; keep the dragged thing under it.
    const scrolled = () => dragged && place(x, y)
    const finish = async (save: boolean) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', key, true)
      root.removeEventListener('scroll', scrolled)
      if (!dragged) return
      cancelAnimationFrame(frame)
      ghost!.remove()
      el.classList.remove('dragging')
      root.classList.remove('grabbing')
      dragged = null
      // Letting go fires a click on what was dragged, which would open the book or fold the section.
      const swallow = (c: MouseEvent) => (c.stopPropagation(), c.preventDefault())
      window.addEventListener('click', swallow, true)
      setTimeout(() => window.removeEventListener('click', swallow, true))
      await drop(save)
    }
    const up = () => finish(true)
    const cancel = () => finish(false)
    const key = (k: KeyboardEvent) => {
      if (k.key === 'Escape' && dragged) {
        k.stopPropagation()
        finish(false)
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', key, true)
    root.addEventListener('scroll', scrolled)
  }

  // A book goes among the others, across sections too (but not into folded ones, which have no grid).
  const draggableBook = (el: HTMLElement, id: string) => {
    el.dataset.id = id
    el.ondragstart = (ev) => ev.preventDefault()
    const place = (x: number, y: number) => {
      const over = document.elementFromPoint(x, y)
      const target = over?.closest<HTMLElement>('.book[data-id]')
      if (target && shelves.contains(target)) {
        if (target === el) return
        const t = target.getBoundingClientRect()
        const after = x > t.left + t.width / 2
        if (after ? target.nextElementSibling !== el : target.previousElementSibling !== el) target[after ? 'after' : 'before'](el)
        return
      }
      // Over a grid's empty space after its last book, or an empty section: the book goes at the end.
      const grid = over?.closest<HTMLElement>('.grid')
      if (!grid || !shelves.contains(grid) || grid.lastElementChild === el) return
      const last = grid.lastElementChild?.getBoundingClientRect()
      if (!last || y > last.bottom || (y >= last.top && x > last.right)) grid.append(el)
    }
    const drop = async (save: boolean) => {
      if (!save) return render()
      const grid = el.parentElement!
      const section = grid.dataset.section || null
      const ids = [...grid.querySelectorAll<HTMLElement>('.book[data-id]')].map((b) => b.dataset.id!)
      const was = books.filter((b) => b.section === section).map((b) => b.id)
      if (ids.join() !== was.join()) await api.books.reorder(section, ids)
      await reload()
    }
    el.onpointerdown = (down) => follow(down, el, el, place, drop)
  }

  // A section goes among the others, by its header; the books at the top of the library stay first.
  const draggableShelf = (el: HTMLElement, head: HTMLElement) => {
    const place = (_x: number, y: number) => {
      for (const s of shelves.querySelectorAll<HTMLElement>(':scope > .shelf')) {
        if (s === el) continue
        const b = s.getBoundingClientRect()
        if (y < b.top + b.height / 2) {
          if (s.previousElementSibling !== el) s.before(el)
          return
        }
      }
      if (shelves.lastElementChild !== el) shelves.append(el)
    }
    const drop = async (save: boolean) => {
      if (!save) return render()
      const ids = [...shelves.querySelectorAll<HTMLElement>(':scope > .shelf')].map((s) => s.dataset.id!)
      if (ids.join() !== sections.map((s) => s.id).join()) await api.sections.reorder(ids)
      await reload()
    }
    head.onpointerdown = (down) => {
      if (!(down.target as HTMLElement).closest('button')) follow(down, el, head, place, drop)
    }
  }

  const sectionMenu = (s: Section) => (ev: MouseEvent) =>
    showMenu(ev, [
      { label: 'Rename…', run: () => ask('Rename section', { value: s.title, ok: 'Rename', check: (v) => api.sections.rename(s.id, v) }).then(reload) },
      {
        label: 'Delete section',
        danger: true,
        run: async () => {
          if (!confirm(`Delete the section "${s.title}"? Its books move back to the top of the library.`)) return
          await api.sections.remove(s.id)
          await reload()
        }
      }
    ])

  // The books at the top of the library (`section` null), or a section's header and books. A folded
  // section shows only its header, so its covers don't load; searching shows its matches anyway.
  const shelf = (section: Section | null, q: string): HTMLElement[] => {
    const all = books.filter((b) => b.section === (section?.id ?? null))
    const shown = all.filter((b) => b.title.toLowerCase().includes(q))
    if (q && !shown.length) return []
    const folded = !q && !!section?.folded
    const grid = h('div', { class: 'grid' })
    grid.dataset.section = section?.id ?? ''
    if (!folded) {
      const cards = shown.map((b) => {
        const el = card(b, covers, reload, report)
        if (!q) draggableBook(el, b.id)
        return el
      })
      const add = h('button', { class: 'book add', onclick: () => newBook(covers) }, h('div', { class: 'cover' }, h('span', { textContent: '+' })), h('b', { textContent: 'New book' }))
      grid.replaceChildren(...(q || section ? [] : [add]), ...cards)
    }
    if (!section) return [grid]

    const menu = sectionMenu(section)
    const fold = async () => {
      section.folded = !section.folded
      el.replaceWith(...shelf(section, q))
      await api.sections.fold(section.id, section.folded)
      // Already drawn: the next reload has nothing new to draw.
      drawn = JSON.stringify([books, sections])
    }
    const head = h('div', { class: 'section-head' },
      h('button', { class: 'icon fold', title: section.folded ? 'Unfold' : 'Fold', textContent: '▾', onclick: (ev: MouseEvent) => (ev.stopPropagation(), fold()) }),
      h('h2', { textContent: section.title }),
      h('small', { textContent: q ? `${shown.length} of ${all.length}` : String(all.length) }),
      h('button', { class: 'icon', title: 'Section options', textContent: '⋯', onclick: (ev: MouseEvent) => (ev.stopPropagation(), menu(ev)) })
    )
    head.oncontextmenu = menu
    const el = h('section', { class: `shelf${folded ? ' folded' : ''}` }, head, ...(folded ? [] : [grid]))
    el.dataset.id = section.id
    if (!q) {
      head.title = `Click to ${section.folded ? 'unfold' : 'fold'}, drag to move`
      head.onclick = fold
      draggableShelf(el, head)
    }
    return [el]
  }

  const render = () => {
    const q = search.value.trim().toLowerCase()
    shelves.replaceChildren(...shelf(null, q), ...sections.flatMap((s) => shelf(s, q)))
    if (q && !shelves.childElementCount) shelves.append(h('p', { class: 'muted', textContent: 'No books match.' }))
  }
  // What the shelves were last drawn from: reloads that change nothing (each time the window gets
  // focus) leave the cards alone rather than building them, and their covers, again.
  let drawn = ''
  const reload = async () => {
    // Mid-drag, a reload would pull the cards out from under the pointer.
    if (dragged) return
    const [b, s] = await Promise.all([api.books.list(), api.sections.list()])
    const now = JSON.stringify([b, s])
    if (now === drawn || dragged) return
    ;[books, sections, drawn] = [b, s, now]
    render()
  }
  search.oninput = render

  root.replaceChildren(
    h('header', {},
      h('h1', { textContent: 'Library' }),
      search,
      h('button', {
        textContent: 'New section',
        onclick: () => ask('New section', { placeholder: 'Section name', ok: 'Create', check: (v) => api.sections.create(v) }).then(reload)
      }),
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
    shelves
  )
  window.addEventListener('focus', reload)
  await reload()
}
