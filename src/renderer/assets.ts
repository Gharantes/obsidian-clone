import { imageTab } from './tabs.ts'
import { h } from './ui.ts'

const { api } = window

// The sidebar's list of the book's images; clicking one opens it in a tab (Ctrl+click or
// middle-click: a new tab). Reloads each time it's shown, so new AI images appear.
export function createAssets(open: (path: string, newTab: boolean) => void) {
  const list = h('ul', { class: 'assets' })
  let loads = 0
  // The active tab's path, to highlight its image.
  let active: string | null = null
  const mark = () => {
    for (const row of list.children) row.classList.toggle('active', (row as HTMLElement).dataset.path === active)
  }
  async function load() {
    const n = ++loads
    const names = await api.images.list().catch(() => [])
    if (n !== loads) return
    list.replaceChildren(
      ...(names.length
        ? names.map((name) => {
            const row = h('li', { class: 'row', title: name }, h('span', { textContent: name }))
            row.dataset.path = imageTab(name)
            row.onclick = (ev) => open(imageTab(name), ev.ctrlKey || ev.metaKey)
            row.onmousedown = (ev) => ev.button === 1 && ev.preventDefault()
            row.onauxclick = (ev) => ev.button === 1 && open(imageTab(name), true)
            return row
          })
        : [h('li', { class: 'muted', textContent: 'No images yet. Images generated with AI, or imported with a book, show up here.' })])
    )
    mark()
  }
  function select(path: string | null) {
    active = path
    mark()
  }
  return { el: h('div', { class: 'panel' }, h('div', { class: 'panel-head', textContent: 'Assets' }), list), load, select }
}
