import { movePath, parentOf } from './explorer.ts'
import { imageTab } from './tabs.ts'
import { ask, h, modal, showMenu, type MenuItem } from './ui.ts'

const { api } = window

type AssetsOpts = {
  // Opens an image tab (see imageTab).
  open(path: string, newTab: boolean): void
  // Saves the editor's pending edits, before a rename changes the notes that embed the image.
  flush(): void
  // Called after an image is renamed, with its old and new names.
  renamed(from: string, to: string): void
  // Called with the names of deleted images.
  deleted(names: string[]): void
}

// What's being dragged in the list: an image (by name) or a folder (by path).
type Dragged = { image: string } | { folder: string }

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const under = (p: string, folder: string) => p === folder || p.startsWith(folder + '/')

// The sidebar's tree of the book's images, in folders that only organize images. Clicking an image
// opens it in a tab (Ctrl+click or middle-click: a new tab); right-click for actions; drag to move,
// or drag an image into a note to embed it. Reloads each time it's shown, so new AI images appear.
export function createAssets(o: AssetsOpts) {
  const list = h('ul', { class: 'tree' })
  let folders: string[] = []
  let images: [string, string][] = []
  const expanded = new Set<string>()
  // The active tab's path, to highlight its image.
  let active: string | null = null
  let dragging: Dragged | null = null
  let loads = 0

  function render(folder: string): HTMLLIElement[] {
    const subfolders = folders.filter((f) => parentOf(f) === folder).map((path) => {
      const open = expanded.has(path)
      const empty = !folders.some((f) => parentOf(f) === path) && !images.some(([, f]) => f === path)
      const row = h('div', { class: `row folder${open ? ' open' : ''}`, title: path, draggable: true },
        h('span', { class: `arrow${empty ? ' none' : ''}` }),
        h('span', { class: 'folder-icon' }),
        h('span', { textContent: baseName(path) })
      )
      row.onclick = () => toggle(path)
      row.oncontextmenu = (ev) => showMenu(ev, folderMenu(path))
      row.ondragstart = (ev) => {
        dragging = { folder: path }
        ev.dataTransfer!.effectAllowed = 'move'
        ev.dataTransfer!.setData('text/plain', path)
      }
      row.ondragend = () => (dragging = null)
      dropTarget(row, path)
      return h('li', {}, row, ...(open ? [h('ul', {}, ...render(path))] : []))
    })
    const files = images.filter(([, f]) => f === folder).map(([name]) => {
      const row = h('div', { class: 'row', title: name, draggable: true }, h('span', { textContent: name }))
      row.dataset.path = imageTab(name)
      row.onclick = (ev) => o.open(imageTab(name), ev.ctrlKey || ev.metaKey)
      row.onmousedown = (ev) => {
        // Blocks middle-click autoscroll. A block body, since returning false would cancel left
        // clicks too and stop rows from being dragged.
        if (ev.button === 1) ev.preventDefault()
      }
      row.onauxclick = (ev) => ev.button === 1 && o.open(imageTab(name), true)
      row.oncontextmenu = (ev) => menu(ev, name)
      row.ondragstart = (ev) => {
        dragging = { image: name }
        ev.dataTransfer!.effectAllowed = 'copyMove'
        // Dropped into a note, it becomes an embed.
        ev.dataTransfer!.setData('text/plain', `![[${name}]]`)
      }
      row.ondragend = () => (dragging = null)
      dropTarget(row, folder)
      return h('li', {}, row)
    })
    return [...subfolders, ...files]
  }

  // Dropping a dragged image or folder on `el` moves it into folder `dest`.
  function dropTarget(el: HTMLElement, dest: string) {
    const ok = () => {
      if (!dragging) return false
      if ('image' in dragging) return images.find(([n]) => n === (dragging as { image: string }).image)?.[1] !== dest
      return parentOf(dragging.folder) !== dest && !under(dest, dragging.folder)
    }
    el.ondragover = (ev) => {
      if (!ok()) return
      ev.preventDefault()
      ev.stopPropagation()
      el.classList.add('drop')
    }
    el.ondragleave = () => el.classList.remove('drop')
    el.ondrop = (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      el.classList.remove('drop')
      if (ok()) move(dragging!, dest)
    }
  }

  const redraw = () => {
    list.replaceChildren(
      ...(folders.length || images.length
        ? render('')
        : [h('li', { class: 'muted empty-hint', textContent: 'No images yet. Add your own, or generate them with AI.' })])
    )
    mark()
  }

  function mark() {
    for (const row of list.querySelectorAll<HTMLElement>('.row[data-path]')) row.classList.toggle('active', row.dataset.path === active)
  }

  async function load() {
    const n = ++loads
    const r = await api.images.list().catch(() => ({ folders: [], images: [] }))
    if (n !== loads) return
    ;({ folders, images } = r)
    redraw()
  }

  function toggle(path: string) {
    if (!expanded.delete(path)) expanded.add(path)
    redraw()
  }

  // Shows a folder's contents, opening the folders it's in.
  function reveal(folder: string) {
    for (let p = folder; p; p = parentOf(p)) expanded.add(p)
  }

  async function move(d: Dragged, dest: string) {
    if ('image' in d) {
      const err = await api.images.move(d.image, dest)
      if (err) alert(err)
    } else {
      const r = await api.images.folders.move(d.folder, dest, baseName(d.folder))
      if ('error' in r) alert(r.error)
      else moved(d.folder, r.path)
    }
    reveal(dest)
    load()
  }

  // Keeps expanded folders in step with a folder's rename or move.
  function moved(from: string, to: string) {
    for (const p of [...expanded]) expanded.delete(p) && expanded.add(movePath(p, from, to))
  }

  async function addImages(folder: string) {
    const r = await api.images.import(folder)
    if (r.error) alert(r.error)
    reveal(folder)
    load()
  }

  async function newFolder(parent: string) {
    const r = await ask('New folder', {
      placeholder: 'Folder name',
      ok: 'Create',
      check: async (v) => {
        const r = await api.images.folders.create(parent, v)
        return 'error' in r ? r.error : null
      }
    })
    if (!r) return
    reveal(parent)
    load()
  }

  async function renameFolder(path: string) {
    let to: string | null = null
    await ask('Rename folder', {
      value: baseName(path),
      ok: 'Rename',
      check: async (v) => {
        const r = await api.images.folders.move(path, parentOf(path), v)
        if ('error' in r) return r.error
        to = r.path
        return null
      }
    })
    if (!to) return
    moved(path, to)
    load()
  }

  async function removeFolder(path: string) {
    const n = images.filter(([, f]) => under(f, path)).length
    const what = n ? ` and the ${n === 1 ? 'image' : `${n} images`} in it` : ''
    if (!confirm(`Delete the folder "${baseName(path)}"${what}? This can't be undone.`)) return
    const names = await api.images.folders.remove(path)
    expanded.delete(path)
    o.deleted(names)
    load()
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

  async function remove(name: string) {
    if (!confirm(`Delete "${name}"? Notes that embed it will show a broken image. This can't be undone.`)) return
    const err = await api.images.remove(name)
    if (err) return alert(err)
    o.deleted([name])
    load()
  }

  async function download(name: string) {
    const err = await api.images.save(name)
    if (err) {
      const dlg = modal('Download failed', [h('p', { class: 'error', textContent: err })], [h('button', { textContent: 'OK', onclick: () => dlg.close() })])
    }
  }

  const folderMenu = (path: string): MenuItem[] => [
    { label: 'Add images…', run: () => addImages(path) },
    { label: 'New folder', run: () => newFolder(path) },
    '-',
    { label: 'Rename…', run: () => renameFolder(path) },
    { label: 'Delete', danger: true, run: () => removeFolder(path) }
  ]

  // An image's actions; also shown on right-click in its tab.
  const menu = (ev: MouseEvent, name: string) =>
    showMenu(ev, [
      { label: 'Open in new tab', run: () => o.open(imageTab(name), true) },
      '-',
      { label: 'Rename…', run: () => rename(name) },
      { label: 'Download…', run: () => download(name) },
      { label: 'Delete', danger: true, run: () => remove(name) }
    ])

  list.oncontextmenu = (ev) =>
    showMenu(ev, [
      { label: 'Add images…', run: () => addImages('') },
      { label: 'New folder', run: () => newFolder('') }
    ])
  dropTarget(list, '')

  function select(path: string | null) {
    active = path
    mark()
  }

  const actions = h('div', { class: 'actions' },
    h('button', { textContent: '+ Images', title: 'Add image files', onclick: () => addImages('') }),
    h('button', { textContent: '+ Folder', title: 'New folder for images', onclick: () => newFolder('') })
  )
  return { el: h('div', { class: 'panel' }, actions, list), load, select, menu }
}
