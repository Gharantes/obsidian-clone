import type { Book } from './api.ts'
import { generateCover } from './library.ts'
import { pickImage } from './assets.ts'
import { h, showMenu } from './ui.ts'

const { api } = window

export type DetailsOpts = {
  // Called after the book is renamed.
  renamed(title: string): void
  // Called after an image was added to the book (an upload or generated cover).
  imagesChanged(): void
}

// The Details page a tab can show: the book's title (edit to rename), its cover, and a summary.
// Made afresh each time the tab is shown; destroy() saves any pending edits.
export function createDetails(initial: Book, o: DetailsOpts) {
  let book = initial
  const title = h('input', { class: 'details-title', value: book.title, title: 'Book title', spellcheck: false })
  const titleError = h('p', { class: 'error' })
  const cover = h('div', { class: 'cover' }, h('span'))
  const summary = h('textarea', { placeholder: 'What is this book about?', value: book.summary })
  const saved = h('p', { class: 'hint' })
  const swatches = h('div', { class: 'swatches' })
  const removeImage = h('button', { textContent: 'Remove image', title: 'Show the cover color instead' })

  const paint = () => {
    cover.style.setProperty('--cover', book.color)
    cover.firstElementChild!.textContent = book.title
    cover.classList.toggle('image', !!book.cover)
    if (book.cover) cover.style.setProperty('--image', `url("${api.images.url(book.id, book.cover)}")`)
    swatches.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.title === book.color))
    removeImage.hidden = !book.cover
  }
  const reload = async () => {
    const b = await api.books.current()
    if (!b) return
    book = { ...b, summary: book.summary } // keep unsaved typing
    if (document.activeElement !== title) title.value = book.title
    paint()
  }

  // Title: saved on Enter or when leaving the box; Escape undoes the edit.
  let renaming = false
  const rename = async () => {
    const v = title.value.trim()
    if (renaming) return
    if (!v || v === book.title) {
      title.value = book.title
      titleError.textContent = ''
      return
    }
    renaming = true
    const err = await api.books.rename(book.id, v).finally(() => (renaming = false))
    titleError.textContent = err ?? ''
    if (err) return
    book.title = title.value = v
    paint()
    o.renamed(v)
  }
  title.onblur = rename
  title.onkeydown = (k) => {
    if (k.key === 'Enter') title.blur()
    else if (k.key === 'Escape') {
      title.value = book.title
      title.blur()
    } else return
    k.preventDefault()
  }

  // Summary: autosaved 500 ms after the last change, and when leaving the box.
  let timer: ReturnType<typeof setTimeout> | undefined
  const saveSummary = async () => {
    clearTimeout(timer)
    timer = undefined
    if (summary.value === book.summary) return
    book.summary = summary.value
    await api.books.setSummary(book.id, summary.value)
    saved.textContent = 'Saved'
  }
  summary.oninput = () => {
    saved.textContent = ''
    clearTimeout(timer)
    timer = setTimeout(saveSummary, 500)
  }
  summary.onblur = saveSummary
  const unload = () => timer && saveSummary()
  window.addEventListener('beforeunload', unload)

  const setCover = async (name: string | null) => {
    await api.books.setCover(book.id, name)
    await reload()
  }
  const setColor = async (color: string) => {
    await api.books.setColor(book.id, color)
    await reload()
  }
  api.books.covers().then((covers) => {
    swatches.replaceChildren(...covers.map((c) => {
      const b = h('button', { title: c, onclick: () => setColor(c) })
      b.style.background = c
      return b
    }))
    paint()
  })

  const upload = async () => {
    const r = await api.images.import('')
    if (r.names.length) o.imagesChanged()
    if (r.error) alert(r.error)
    if (r.names[0]) await setCover(r.names[0])
  }
  const choose = async () => {
    const name = await pickImage(book.id, 'Choose cover image', book.cover)
    if (name) await setCover(name)
  }
  const generate = async () => {
    const before = book.cover
    await generateCover(book)
    await reload()
    if (book.cover !== before) o.imagesChanged()
  }
  const imageButton = h('button', {
    textContent: 'Image…',
    title: 'Pick, upload or generate a cover image',
    onclick: (ev: MouseEvent) =>
      showMenu(ev, [
        { label: 'Choose from book images…', run: choose },
        { label: 'Upload image…', run: upload },
        { label: 'Generate with AI…', run: generate }
      ])
  })
  removeImage.onclick = () => setCover(null)
  cover.onclick = choose
  cover.title = 'Choose cover image'

  paint()
  const el = h('div', { class: 'details-page' },
    h('header', {}, title, titleError),
    h('div', { class: 'details-body' },
      h('section', { class: 'details-cover' },
        h('h3', { textContent: 'Cover' }),
        cover,
        h('div', { class: 'cover-actions' }, imageButton, removeImage),
        h('small', { class: 'muted', textContent: 'Color, shown when there is no image' }),
        swatches
      ),
      h('section', { class: 'details-summary' }, h('h3', { textContent: 'Summary' }), summary, saved)
    )
  )
  return {
    el,
    // Saves edits not saved yet: removing the page doesn't blur its boxes.
    destroy() {
      window.removeEventListener('beforeunload', unload)
      if (summary.value !== book.summary) saveSummary()
      if (title.value.trim() && title.value.trim() !== book.title) rename()
      el.remove()
    }
  }
}
