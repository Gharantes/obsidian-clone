import { h, modal } from './ui.ts'

const { api } = window

// The sidebar's list of the book's images. Reloads each time it's shown, so new AI images appear.
export function createAssets(book: string) {
  const list = h('ul', { class: 'assets' })
  const preview = (name: string) => {
    const close = h('button', { textContent: 'Close', onclick: () => dlg.close() })
    const dlg = modal(name, [h('img', { class: 'asset-preview', src: api.images.url(book, name), alt: name })], [close])
    dlg.box.classList.add('wide')
  }
  let loads = 0
  async function load() {
    const n = ++loads
    const names = await api.images.list().catch(() => [])
    if (n !== loads) return
    list.replaceChildren(
      ...(names.length
        ? names.map((name) =>
            h('li', {},
              h('button', { title: name, onclick: () => preview(name) },
                h('img', { src: api.images.url(book, name), alt: '', loading: 'lazy' }),
                h('span', { textContent: name })
              )
            )
          )
        : [h('li', { class: 'muted', textContent: 'No images yet. Images generated with AI, or imported with a book, show up here.' })])
    )
  }
  return { el: h('div', { class: 'panel' }, h('div', { class: 'panel-head', textContent: 'Assets' }), list), load }
}
