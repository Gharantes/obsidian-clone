import type { Entry } from '../main/files.ts'
import { showMenu, type MenuItem } from './ui.ts'

type Handlers = {
  open(path: string): void
  renamed(from: string, to: string): void
  deleted(path: string): void
}

const files = () => window.api.files
const isNote = (e: Entry) => !e.folder && e.name.endsWith('.md')
const label = (e: Entry) => (isNote(e) ? e.name.slice(0, -3) : e.name)
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
export const parentOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')))

// Path after `from` was renamed or moved to `to` (unchanged when unrelated). Renaming a folder
// renames its folder note too: "A/A.md" becomes "B/B.md".
export function movePath(p: string, from: string, to: string): string {
  if (p !== from && !p.startsWith(from + '/')) return p
  if (to && p === `${from}/${baseName(from)}.md`) return `${to}/${baseName(to)}.md`
  return to + p.slice(from.length)
}

function find(entries: Entry[], path: string): Entry | undefined {
  for (const e of entries) {
    if (e.path === path) return e
    const hit = e.children && find(e.children, path)
    if (hit) return hit
  }
}

// File tree in folder-note style: a folder with a note of the same name shows as one item that
// opens the note; its arrow expands it. Right-click for actions, drag to move.
export function createExplorer(list: HTMLElement, h: Handlers) {
  let tree: Entry[] = []
  let active: string | null = null
  let renaming = false
  let dragging: string | null = null
  const expanded = new Set<string>()

  function render(entries: Entry[]): HTMLLIElement[] {
    return entries.map((e) => {
      const li = document.createElement('li')
      const row = li.appendChild(document.createElement('div'))
      const open = expanded.has(e.path)
      row.className = ['row', e.folder && 'folder', open && 'open', e.note && 'has-note', (e.path === active || e.note === active) && 'active', !e.folder && !isNote(e) && 'other']
        .filter(Boolean)
        .join(' ')
      row.dataset.path = e.path
      if (e.folder) {
        const arrow = row.appendChild(document.createElement('span'))
        arrow.className = 'arrow'
        arrow.onclick = (ev) => (ev.stopPropagation(), toggle(e.path))
        if (!e.children!.length) arrow.classList.add('none')
      }
      row.appendChild(document.createElement('span')).textContent = label(e)
      row.onclick = () => (e.note ? (expanded.add(e.path), openNote(e.note)) : e.folder ? toggle(e.path) : isNote(e) && openNote(e.path))
      row.oncontextmenu = (ev) => showMenu(ev, menuFor(e, row))
      row.draggable = true
      row.ondragstart = (ev) => {
        dragging = e.path
        ev.dataTransfer!.effectAllowed = 'move'
        ev.dataTransfer!.setData('text/plain', e.path)
      }
      row.ondragend = () => (dragging = null)
      dropTarget(row, e.folder ? e.path : parentOf(e.path))
      if (e.folder && open) li.appendChild(document.createElement('ul')).append(...render(e.children!))
      return li
    })
  }

  // Dropping a dragged entry on `el` moves it into folder `dest`.
  function dropTarget(el: HTMLElement, dest: string) {
    const ok = () => dragging !== null && parentOf(dragging) !== dest && dest !== dragging && !dest.startsWith(dragging + '/')
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

  const redraw = () => list.replaceChildren(...render(tree))

  async function refresh() {
    if (renaming) return
    tree = await files().list()
    redraw()
  }

  function toggle(path: string) {
    if (!expanded.delete(path)) expanded.add(path)
    redraw()
  }

  function openNote(path: string) {
    active = path
    h.open(path)
    redraw()
  }

  // Keeps the open note, expanded folders and editor in step with a rename or move.
  function moved(from: string, to: string) {
    if (active) active = movePath(active, from, to)
    for (const p of [...expanded]) expanded.delete(p) && expanded.add(movePath(p, from, to))
    h.renamed(from, to)
  }

  function menuFor(e: Entry, row: HTMLElement): MenuItem[] {
    const items: MenuItem[] = []
    if (e.folder) {
      items.push({ label: 'New note', run: () => create(false, e.path) }, { label: 'New folder', run: () => create(true, e.path) })
      if (!e.note) items.push({ label: 'Create folder note', run: () => createFolderNote(e) })
      items.push('-')
    } else if (isNote(e)) items.push({ label: 'New note inside', run: () => nestAndCreate(e) }, '-')
    items.push({ label: 'Rename', run: () => startRename(e, row) }, { label: 'Delete', danger: true, run: () => remove(e) })
    return items
  }

  function startRename(e: Entry, row: HTMLElement) {
    const ext = isNote(e) ? '.md' : ''
    const input = document.createElement('input')
    input.value = label(e)
    renaming = true
    row.replaceChildren(input)
    row.draggable = false
    input.focus()
    input.select()

    let done = false
    const finish = async (commit: boolean) => {
      if (done) return
      done = true
      const name = input.value.trim() + ext
      if (commit && name !== e.name) {
        const r = await files().rename(e.path, name)
        if ('error' in r) alert(r.error)
        else moved(e.path, r.path)
      }
      renaming = false
      refresh()
    }
    input.onkeydown = (k) => (k.key === 'Enter' ? finish(true) : k.key === 'Escape' && finish(false))
    input.onblur = () => finish(true)
    input.onclick = (ev) => ev.stopPropagation()
  }

  async function remove(e: Entry) {
    const what = e.folder ? `the folder "${label(e)}" and everything in it` : `"${label(e)}"`
    if (!confirm(`Delete ${what}? It will be moved to the system trash.`)) return
    if (!(await files().trash(e.path))) {
      if (!confirm(`Couldn't move "${label(e)}" to the system trash. Delete it permanently?`)) return
      await files().remove(e.path)
    }
    if (active && movePath(active, e.path, '') !== active) active = null
    h.deleted(e.path)
    refresh()
  }

  async function move(path: string, dest: string) {
    const r = await files().move(path, dest)
    if ('error' in r) return alert(r.error)
    if (dest) expanded.add(dest)
    moved(path, r.path)
    refresh()
  }

  // Creates "Untitled" in `parent` ('' = root), opens it and starts renaming it.
  // New folders come with a folder note, so they open like notes.
  async function create(folder: boolean, parent = '') {
    const path = await files().create(folder, parent)
    for (let p = parent; p; p = parentOf(p)) expanded.add(p)
    tree = await files().list()
    const entry = find(tree, path)
    const note = folder ? entry?.note : path
    if (note) openNote(note)
    else redraw()
    const row = list.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)
    if (row && entry) startRename(entry, row)
  }

  async function createFolderNote(e: Entry) {
    const path = `${e.path}/${e.name}.md`
    await files().write(path, '')
    expanded.add(e.path)
    tree = await files().list()
    openNote(path)
  }

  // Turns a note into a folder note, then creates a new note inside it.
  async function nestAndCreate(e: Entry) {
    const r = await files().nest(e.path)
    if ('error' in r) return alert(r.error)
    moved(e.path, r.path)
    await create(false, parentOf(r.path))
  }

  list.oncontextmenu = (ev) =>
    showMenu(ev, [
      { label: 'New note', run: () => create(false) },
      { label: 'New folder', run: () => create(true) }
    ])
  dropTarget(list, '')
  files().onChange(refresh)
  refresh()
  return { create, refresh }
}
