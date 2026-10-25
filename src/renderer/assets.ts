import { imageTab } from './tabs.ts'
import { ask, h, modal, showMenu } from './ui.ts'

const { api } = window

type AssetsOpts = {
  // Opens an image tab (see imageTab).
  open(path: string, newTab: boolean): void
  // Saves the editor's pending edits, before a rename changes the notes that embed the image.
  flush(): void
  // Called after an image is renamed, with its old and new names.
  renamed(from: string, to: string): void
}

// The sidebar's list of the book's images; clicking one opens it in a tab (Ctrl+click or
// middle-click: a new tab), right-click to rename or download it. Reloads each time it's shown,
// so new AI images appear.
export function createAssets(o: AssetsOpts) {
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
            row.onclick = (ev) => o.open(imageTab(name), ev.ctrlKey || ev.metaKey)
            row.onmousedown = (ev) => ev.button === 1 && ev.preventDefault()
            row.onauxclick = (ev) => ev.button === 1 && o.open(imageTab(name), true)
            row.oncontextmenu = (ev) => menu(ev, name)
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

  // Renaming also updates the notes that embed the image.
  async function rename(name: string) {
    let to: string | null = null
    await ask('Rename image', {
      value: name,
      ok: 'Rename',
      check: async (v) => {
        o.flush()
        const r = await api.images.rename(name, v)
        if ('error' in r) return r.error
        to = r.name
        return null
      }
    })
    if (!to || to === name) return
    o.renamed(name, to)
    load()
  }

  async function download(name: string) {
    const err = await api.images.save(name)
    if (err) {
      const dlg = modal('Download failed', [h('p', { class: 'error', textContent: err })], [h('button', { textContent: 'OK', onclick: () => dlg.close() })])
    }
  }

  const menu = (ev: MouseEvent, name: string) =>
    showMenu(ev, [
      { label: 'Open in new tab', run: () => o.open(imageTab(name), true) },
      '-',
      { label: 'Rename…', run: () => rename(name) },
      { label: 'Download…', run: () => download(name) }
    ])

  return { el: h('div', { class: 'panel' }, h('div', { class: 'panel-head', textContent: 'Assets' }), list), load, select, menu }
}
