import type { Entry } from './api.ts'
import { showMenu, type MenuItem } from './ui.ts'

type Handlers = {
  open(path: string, newTab?: boolean): void
  renamed(from: string, to: string): void
  deleted(path: string): void
  // Called with the tree each time it is read.
  listed(tree: Entry[]): void
}

const files = () => window.api.files
export const isNote = (e: Entry) => !e.folder && e.name.endsWith('.md')
export const label = (e: Entry) => (isNote(e) ? e.name.slice(0, -3) : e.name)
export const parentOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')))

// Path after `from` was renamed or moved to `to` (unchanged when unrelated).
export function movePath(p: string, from: string, to: string): string {
  if (p !== from && !p.startsWith(from + '/')) return p
  return to + p.slice(from.length)
}

export function find(entries: Entry[], path: string): Entry | undefined {
  for (const e of entries) {
    if (e.path === path) return e
    const hit = e.children && find(e.children, path)
    if (hit) return hit
  }
}

// File tree: folders organize notes, and clicking one expands or collapses it. Right-click for
// actions, drag to move.
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
      row.className = ['row', e.folder && 'folder', open && 'open', e.path === active && 'active', !e.folder && !isNote(e) && 'other']
        .filter(Boolean)
        .join(' ')
      row.dataset.path = e.path
      if (e.folder) {
        const arrow = row.appendChild(document.createElement('span'))
        arrow.className = 'arrow'
        arrow.onclick = (ev) => (ev.stopPropagation(), toggle(e.path))
        if (!e.children!.length) arrow.classList.add('none')
        row.appendChild(document.createElement('span')).className = 'folder-icon'
      }
      row.appendChild(document.createElement('span')).textContent = label(e)
      // Ctrl/Cmd+click or middle-click opens the note in a new tab.
      const target = isNote(e) ? e.path : undefined
      row.onclick = (ev) => {
        if (e.folder) return toggle(e.path)
        if (target) openNote(target, ev.ctrlKey || ev.metaKey)
      }
      row.onmousedown = (ev) => {
        // Blocks middle-click autoscroll. A block body, since returning false would cancel left
        // clicks too and stop rows from being dragged.
        if (ev.button === 1) ev.preventDefault()
      }
      row.onauxclick = (ev) => ev.button === 1 && target && openNote(target, true)
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

  async function load() {
    tree = await files().list()
    h.listed(tree)
  }

  async function refresh() {
    if (renaming) return
    await load()
    redraw()
  }

  function toggle(path: string) {
    if (!expanded.delete(path)) expanded.add(path)
    redraw()
  }

  function openNote(path: string, newTab = false) {
    active = path
    h.open(path, newTab)
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
    if (isNote(e)) items.push({ label: 'Open in new tab', run: () => openNote(e.path, true) }, '-')
    if (e.folder) items.push({ label: 'New note', run: () => create(false, e.path) }, { label: 'New folder', run: () => create(true, e.path) }, '-')
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
    input.onkeydown = (k) => {
      if (k.key === 'Enter') finish(true)
      else if (k.key === 'Escape') finish(false)
    }
    input.onblur = () => finish(true)
    input.onclick = (ev) => ev.stopPropagation()
  }

  async function remove(e: Entry) {
    const what = e.folder ? `the folder "${label(e)}" and everything in it` : `"${label(e)}"`
    if (!confirm(`Delete ${what}? This can't be undone.`)) return
    await files().remove(e.path)
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

  // Creates "Untitled" in `parent` ('' = root) and starts renaming it; a new note also opens.
  async function create(folder: boolean, parent = '') {
    const path = await files().create(folder, parent)
    for (let p = parent; p; p = parentOf(p)) expanded.add(p)
    await load()
    const entry = find(tree, path)
    if (folder) redraw()
    else openNote(path)
    const row = list.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)
    if (row && entry) startRename(entry, row)
  }

  list.oncontextmenu = (ev) =>
    showMenu(ev, [
      { label: 'New note', run: () => create(false) },
      { label: 'New folder', run: () => create(true) }
    ])
  dropTarget(list, '')
  refresh()
  // Opens a note from outside the tree, expanding the folders it's in.
  function open(path: string, newTab = false) {
    for (let p = parentOf(path); p; p = parentOf(p)) expanded.add(p)
    openNote(path, newTab)
  }

  // Highlights the note in the active tab.
  function select(path: string | null) {
    if (path === active) return
    active = path
    if (!renaming) redraw()
  }

  return { create, refresh, open, select }
}
