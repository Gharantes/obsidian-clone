import { movePath, parentOf } from './explorer.ts'
import { isVideo, videoPreview } from './media.ts'
import { imageTab } from './tabs.ts'
import { ask, h, modal, showMenu, type MenuItem } from './ui.ts'

const { api } = window

type AssetsOpts = {
  // Opens an image tab (see imageTab).
  open(path: string, newTab: boolean): void
  // Saves the editor's pending edits, before a move or rename changes the notes that embed images.
  flush(): void
  // Called after an image or image folder moved or was renamed, with its old and new paths; the
  // notes that embed its images were updated.
  renamed(from: string, to: string): void
  // Called with the paths of deleted images.
  deleted(paths: string[]): void
  // Opens the Assets page tab, the images in a grid (see createGallery).
  gallery(): void
  // Called after the images were reread, so the Assets page can follow.
  loaded(): void
}

// What's being dragged in the list: an image or a folder, by path.
type Dragged = { image: string } | { folder: string }

const GRID = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>'

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const under = (p: string, folder: string) => p === folder || p.startsWith(folder + '/')
// An image's path (see api.images) from its name and folder.
export const imagePath = (name: string, folder: string) => (folder ? `${folder}/${name}` : name)

// A tile's picture of an image or video in the Assets: its thumbnail, or a video's first frame.
const preview = (book: string, path: string) =>
  isVideo(path) ? videoPreview(api.images.url(book, path)) : h('img', { src: api.images.thumb(book, path), alt: baseName(path), loading: 'lazy' })

// Picks one of the book's images (and videos, with `videos`; covers can't be videos) in a dialog,
// filtered by typing part of its path; resolves to its path, or null when cancelled.
export async function pickImage(book: string, title: string, current: string | null = null, videos = false): Promise<string | null> {
  const listed = await api.images.list().catch(() => ({ images: [] as [string, string][] }))
  const images = listed.images.filter(([name]) => videos || !isVideo(name))
  return new Promise((resolve) => {
    let chosen: string | null = null
    const pick = (path: string) => {
      chosen = path
      dlg.close()
    }
    const buttons = images.map(([name, folder]) => {
      const path = imagePath(name, folder)
      const b = h('button', { class: path === current ? 'on' : '', title: path, onclick: () => pick(path) }, preview(book, path))
      b.dataset.label = path.toLowerCase()
      return b
    })
    const grid = h('div', { class: 'image-grid' }, ...buttons)
    const none = h('p', { class: 'muted', textContent: 'No image matches.', hidden: true })
    const filter = h('input', { placeholder: 'Filter by name or folder', spellcheck: false })
    filter.oninput = () => {
      const q = filter.value.trim().toLowerCase()
      for (const b of buttons) b.hidden = !b.dataset.label!.includes(q)
      none.hidden = buttons.some((b) => !b.hidden)
    }
    // Enter picks the first image shown.
    filter.onkeydown = (k) => {
      const first = buttons.find((b) => !b.hidden)
      if (k.key === 'Enter' && first) first.click()
    }
    const body = images.length ? [filter, grid, none] : [h('p', { class: 'muted', textContent: 'This book has no images yet. Add some in the Assets panel, or generate them with AI.' })]
    const dlg = modal(title, body, [h('button', { textContent: 'Cancel', onclick: () => dlg.close() })], () => resolve(chosen))
    if (images.length) filter.focus()
  })
}

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
      const path = imagePath(name, folder)
      const row = h('div', { class: 'row', title: path, draggable: true }, h('span', { textContent: name }))
      row.dataset.path = imageTab(path)
      row.onclick = (ev) => o.open(imageTab(path), ev.ctrlKey || ev.metaKey)
      row.onmousedown = (ev) => {
        // Blocks middle-click autoscroll. A block body, since returning false would cancel left
        // clicks too and stop rows from being dragged.
        if (ev.button === 1) ev.preventDefault()
      }
      row.onauxclick = (ev) => ev.button === 1 && o.open(imageTab(path), true)
      row.oncontextmenu = (ev) => menu(ev, path)
      row.ondragstart = (ev) => {
        dragging = { image: path }
        ev.dataTransfer!.effectAllowed = 'copyMove'
        // Dropped into a note, it becomes an embed.
        ev.dataTransfer!.setData('text/plain', `![[${path}]]`)
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
      if ('image' in dragging) return parentOf(dragging.image) !== dest
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
        : [h('li', { class: 'muted empty-hint', textContent: 'No images or videos yet. Add your own, or generate images with AI.' })])
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
    o.loaded()
  }

  function toggle(path: string) {
    if (!expanded.delete(path)) expanded.add(path)
    redraw()
  }

  // Shows a folder's contents, opening the folders it's in.
  function reveal(folder: string) {
    for (let p = folder; p; p = parentOf(p)) expanded.add(p)
  }

  // Moving changes the notes that embed the moved images.
  async function move(d: Dragged, dest: string) {
    o.flush()
    const from = 'image' in d ? d.image : d.folder
    const r = 'image' in d ? await api.images.move(d.image, dest) : await api.images.folders.move(d.folder, dest, baseName(d.folder))
    if ('error' in r) alert(r.error)
    else {
      if ('folder' in d) moved(d.folder, r.path)
      o.renamed(from, r.path)
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

  // Asks for a pixiv link and downloads the artwork's images into folder/<artwork id>. The dialog
  // stays open with the error when nothing came down; pages that failed alone are listed after.
  const addFromPixiv = (folder: string) =>
    addFromLink(folder, 'Add from pixiv', 'https://www.pixiv.net/en/artworks/141886602', 'Downloads every page of the artwork into a folder named after its id. For R-18 works, add your pixiv session in Settings → pixiv.', 'pages', api.images.importPixiv)

  // Reddit: same, into folder/<post id>.
  const addFromReddit = (folder: string) =>
    addFromLink(folder, 'Add from Reddit', 'https://www.reddit.com/r/…/comments/1urq4lt/…', 'Downloads every image of the post (a gallery, a single image or images in its text) into a folder named after its id. Needs your Reddit session in Settings → Reddit.', 'images', api.images.importReddit)

  async function addFromLink(folder: string, title: string, placeholder: string, hint: string, what: string, importer: (folder: string, link: string) => Promise<{ paths: string[]; error: string | null }>) {
    let added: { paths: string[]; error: string | null } | null = null
    await ask(title, {
      placeholder,
      hint,
      ok: 'Download',
      busy: 'Downloading…',
      check: async (v) => {
        try {
          added = await importer(folder, v)
          return null
        } catch (e) {
          return String(e)
        }
      }
    })
    if (!added) return
    const { paths, error } = added as { paths: string[]; error: string | null }
    if (error) alert(`Some ${what} weren't downloaded:\n${error}`)
    if (paths.length) reveal(parentOf(paths[0]))
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
        o.flush()
        const r = await api.images.folders.move(path, parentOf(path), v)
        if ('error' in r) return r.error
        to = r.path
        return null
      }
    })
    if (!to || to === path) return
    moved(path, to)
    o.renamed(path, to)
    load()
  }

  async function removeFolder(path: string) {
    const n = images.filter(([, f]) => under(f, path)).length
    const what = n ? ` and the ${n === 1 ? 'image' : `${n} images`} in it` : ''
    if (!confirm(`Delete the folder "${baseName(path)}"${what}? This can't be undone.`)) return
    const paths = await api.images.folders.remove(path)
    expanded.delete(path)
    o.deleted(paths)
    load()
  }

  // Renaming also updates the notes that embed the image.
  async function rename(path: string) {
    let to: string | null = null
    await ask(isVideo(path) ? 'Rename video' : 'Rename image', {
      value: baseName(path),
      ok: 'Rename',
      check: async (v) => {
        o.flush()
        const r = await api.images.rename(path, v)
        if ('error' in r) return r.error
        to = r.path
        return null
      }
    })
    if (!to || to === path) return
    o.renamed(path, to)
    load()
  }

  async function remove(path: string) {
    if (!confirm(`Delete "${baseName(path)}"? Notes that embed it will show a broken image. This can't be undone.`)) return
    const err = await api.images.remove(path)
    if (err) return alert(err)
    o.deleted([path])
    load()
  }

  async function download(path: string) {
    const err = await api.images.save(path)
    if (err) {
      const dlg = modal('Download failed', [h('p', { class: 'error', textContent: err })], [h('button', { textContent: 'OK', onclick: () => dlg.close() })])
    }
  }

  const folderMenu = (path: string): MenuItem[] => [
    { label: 'Add images or videos…', run: () => addImages(path) },
    { label: 'Add from pixiv…', run: () => addFromPixiv(path) },
    { label: 'Add from Reddit…', run: () => addFromReddit(path) },
    { label: 'New folder', run: () => newFolder(path) },
    '-',
    { label: 'Rename…', run: () => renameFolder(path) },
    { label: 'Delete', danger: true, run: () => removeFolder(path) }
  ]

  // An image's actions, by its path; also shown on right-click in its tab.
  const menu = (ev: MouseEvent, path: string) =>
    showMenu(ev, [
      { label: 'Open in new tab', run: () => o.open(imageTab(path), true) },
      '-',
      { label: 'Rename…', run: () => rename(path) },
      { label: 'Download…', run: () => download(path) },
      { label: 'Delete', danger: true, run: () => remove(path) }
    ])

  list.oncontextmenu = (ev) =>
    showMenu(ev, [
      { label: 'Add images or videos…', run: () => addImages('') },
      { label: 'Add from pixiv…', run: () => addFromPixiv('') },
      { label: 'Add from Reddit…', run: () => addFromReddit('') },
      { label: 'New folder', run: () => newFolder('') }
    ])
  dropTarget(list, '')

  function select(path: string | null) {
    active = path
    mark()
  }

  const actions = h('div', { class: 'actions' },
    h('button', { class: 'grid-view', innerHTML: GRID, title: 'Show all images and videos in a grid', onclick: () => o.gallery() })
  )
  return { el: h('div', { class: 'panel' }, actions, list), load, select, menu }
}

type GalleryOpts = {
  // Opens an image tab (see imageTab).
  open(path: string, newTab: boolean): void
  // An image's right-click actions (createAssets' menu).
  menu(ev: MouseEvent, path: string): void
}

// The Assets page a tab can show: every image in the book as a grid of thumbnails, one section per
// folder, filtered by typing part of a path. Clicking an image opens it in this tab (Ctrl+click or
// middle-click: a new tab); right-click for its actions. load() rereads the images.
export function createGallery(book: string, o: GalleryOpts) {
  const sections = h('div', { class: 'gallery-sections' })
  const none = h('p', { class: 'muted', hidden: true })
  const filter = h('input', { placeholder: 'Filter by name or folder', spellcheck: false })
  let loads = 0

  const tile = (name: string, folder: string) => {
    const path = imagePath(name, folder)
    const b = h('button', { class: `gallery-tile${isVideo(path) ? ' video' : ''}`, title: path }, preview(book, path), h('span', { textContent: name }))
    b.dataset.label = path.toLowerCase()
    b.onclick = (ev) => o.open(imageTab(path), ev.ctrlKey || ev.metaKey)
    b.onmousedown = (ev) => {
      if (ev.button === 1) ev.preventDefault() // no middle-click autoscroll
    }
    b.onauxclick = (ev) => ev.button === 1 && o.open(imageTab(path), true)
    b.oncontextmenu = (ev) => o.menu(ev, path)
    return b
  }

  // Shows the images whose path holds the filter's text, and the sections that have any.
  const apply = () => {
    const q = filter.value.trim().toLowerCase()
    let shown = 0
    for (const s of sections.children) {
      const tiles = [...s.querySelectorAll<HTMLElement>('.gallery-tile')]
      for (const t of tiles) t.hidden = !t.dataset.label!.includes(q)
      const n = tiles.filter((t) => !t.hidden).length
      ;(s as HTMLElement).hidden = !n
      shown += n
    }
    if (!sections.children.length) none.textContent = 'This book has no images yet. Add some in the Assets panel, or generate them with AI.'
    else none.textContent = 'No image matches.'
    none.hidden = !!shown
  }

  async function load() {
    const n = ++loads
    const { images } = await api.images.list().catch(() => ({ images: [] as [string, string][] }))
    if (n !== loads) return
    const byFolder = new Map<string, string[]>()
    for (const [name, folder] of images) byFolder.set(folder, [...(byFolder.get(folder) ?? []), name])
    const folders = [...byFolder.keys()].sort((a, b) => (a ? b ? a.localeCompare(b) : 1 : -1))
    sections.replaceChildren(...folders.map((folder) =>
      h('section', {},
        ...(folders.length > 1 || folder ? [h('h3', { textContent: folder || 'Top level' })] : []),
        h('div', { class: 'gallery-grid' }, ...byFolder.get(folder)!.map((name) => tile(name, folder)))
      )
    ))
    apply()
  }

  filter.oninput = apply
  load()
  const el = h('div', { class: 'details-page gallery-page' }, h('header', {}, filter), sections, none)
  return { el, load }
}
