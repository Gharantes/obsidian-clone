import type { Book } from './api.ts'
import { h, showMenu } from './ui.ts'

const { api } = window

// The Tags page a tab can show: a one-column table of the book's tags and a button that adds a
// row. A row is edited in place and saved when its box is left; a row left empty is removed.
// Made afresh each time the tab is shown; destroy() saves any pending edit.
export function createTags(book: Book) {
  let tags = [...book.tags]
  const body = h('tbody')
  const empty = h('p', { class: 'muted', textContent: 'No tags yet.' })

  const save = () => api.books.setTags(book.id, tags)

  // Reads the boxes back into the list, dropping empty rows.
  const commit = () => {
    const next = [...body.querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean)
    if (next.length !== body.rows.length) draw()
    if (next.join('\n') === tags.join('\n')) return
    tags = next
    save()
  }

  const row = (value: string) => {
    const input = h('input', { value, placeholder: 'Tag name', spellcheck: false })
    input.onblur = commit
    input.onkeydown = (k) => {
      if (k.key === 'Enter') input.blur()
      else if (k.key === 'Escape') {
        input.value = value
        input.blur()
      } else return
      k.preventDefault()
    }
    const tr = h('tr', {}, h('td', {}, input))
    tr.oncontextmenu = (ev) =>
      showMenu(ev, [{
        label: 'Delete tag',
        danger: true,
        run: () => {
          tr.remove()
          commit()
        }
      }])
    return tr
  }

  const draw = () => {
    body.replaceChildren(...tags.map(row))
    empty.hidden = tags.length > 0
  }

  const add = () => {
    const tr = row('')
    body.append(tr)
    empty.hidden = true
    tr.querySelector('input')!.focus()
  }

  window.addEventListener('beforeunload', commit)
  draw()
  const el = h('div', { class: 'details-page tags-page' },
    h('h2', { textContent: 'Tags' }),
    h('table', { class: 'tags-table' }, h('thead', {}, h('tr', {}, h('th', { textContent: 'Tag' }))), body),
    empty,
    h('div', { class: 'add-tag' }, h('button', { textContent: '+ Add tag', onclick: add }))
  )
  return {
    el,
    // Saves an edit not saved yet: removing the page doesn't blur its boxes.
    destroy() {
      window.removeEventListener('beforeunload', commit)
      commit()
      el.remove()
    }
  }
}
