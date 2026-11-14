import type { Book, Tag } from './api.ts'
import { h } from './ui.ts'

const { api } = window

const TRASH = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>'

// The Tags page a tab can show: a table of the book's tags (name, color, and a delete button per
// row) and a button that adds a row. A name is edited in place and saved when its box is left; a
// row left without a name is removed. Colors come from the book cover palette.
// Made afresh each time the tab is shown; destroy() saves any pending edit.
export function createTags(book: Book) {
  let tags: Tag[] = book.tags.map((t) => ({ ...t }))
  let palette: string[] = []
  const body = h('tbody')
  const empty = h('p', { class: 'muted', textContent: 'No tags yet.' })
  // Each row's color.
  const colors = new WeakMap<HTMLTableRowElement, string>()

  // Reads the rows back into the list, dropping nameless ones, and saves it if it changed.
  const commit = () => {
    const next = [...body.rows]
      .map((tr) => ({ name: tr.querySelector('input')!.value.trim(), color: colors.get(tr)! }))
      .filter((t) => t.name)
    if (next.length !== body.rows.length) draw()
    if (JSON.stringify(next) === JSON.stringify(tags)) return
    tags = next
    api.books.setTags(book.id, tags)
  }

  // The palette shown under a row's swatch; picking a color or clicking elsewhere closes it.
  let picker: HTMLElement | null = null
  let opener: HTMLElement | null = null
  const closePicker = () => {
    picker?.remove()
    picker = opener = null
    document.removeEventListener('mousedown', outside, true)
  }
  const outside = (ev: MouseEvent) => {
    const t = ev.target as Node
    if (!picker?.contains(t) && !opener?.contains(t)) closePicker()
  }
  const pick = (tr: HTMLTableRowElement, swatch: HTMLButtonElement) => {
    const toggle = opener === swatch
    closePicker()
    if (toggle) return
    picker = h('div', { class: 'swatches tag-picker' }, ...palette.map((c) => {
      const b = h('button', { title: c, class: c === colors.get(tr) ? 'on' : '' })
      b.style.background = c
      b.onclick = () => {
        colors.set(tr, c)
        swatch.style.background = c
        closePicker()
        commit()
      }
      return b
    }))
    opener = swatch
    const r = swatch.getBoundingClientRect()
    Object.assign(picker.style, { left: `${r.left}px`, top: `${r.bottom + 6}px` })
    document.body.append(picker)
    document.addEventListener('mousedown', outside, true)
  }

  const row = (tag: Tag) => {
    const input = h('input', { value: tag.name, placeholder: 'Tag name', spellcheck: false })
    input.onblur = commit
    input.onkeydown = (k) => {
      if (k.key === 'Enter') input.blur()
      else if (k.key === 'Escape') {
        input.value = tag.name
        input.blur()
      } else return
      k.preventDefault()
    }
    const swatch = h('button', { class: 'tag-swatch', title: 'Change color' })
    swatch.style.background = tag.color
    const remove = h('button', { class: 'icon', title: 'Delete tag', innerHTML: TRASH })
    const tr = h('tr', {},
      h('td', {}, input),
      h('td', { class: 'tag-color' }, swatch),
      h('td', { class: 'tag-delete' }, remove)
    )
    colors.set(tr, tag.color)
    swatch.onclick = () => pick(tr, swatch)
    remove.onclick = () => {
      closePicker()
      tr.remove()
      commit()
    }
    return tr
  }

  const draw = () => {
    body.replaceChildren(...tags.map(row))
    empty.hidden = tags.length > 0
  }

  // A new row takes the first palette color no tag has yet.
  const add = () => {
    const used = new Set([...body.rows].map((tr) => colors.get(tr)))
    const color = palette.find((c) => !used.has(c)) ?? palette[body.rows.length % palette.length] ?? '#6f6e77'
    const tr = row({ name: '', color })
    body.append(tr)
    empty.hidden = true
    tr.querySelector('input')!.focus()
  }

  api.books.covers().then((c) => (palette = c))
  window.addEventListener('beforeunload', commit)
  draw()
  const el = h('div', { class: 'details-page tags-page' },
    h('h2', { textContent: 'Tags' }),
    h('table', { class: 'tags-table' },
      h('thead', {}, h('tr', {},
        h('th', { textContent: 'Tag' }),
        h('th', { class: 'tag-color', textContent: 'Color' }),
        h('th', { class: 'tag-delete' })
      )),
      body
    ),
    empty,
    h('div', { class: 'add-tag' }, h('button', { textContent: '+ Add tag', onclick: add }))
  )
  return {
    el,
    // Saves an edit not saved yet: removing the page doesn't blur its boxes.
    destroy() {
      window.removeEventListener('beforeunload', commit)
      closePicker()
      commit()
      el.remove()
    }
  }
}
