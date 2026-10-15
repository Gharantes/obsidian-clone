import type { Entry } from '../main/files.ts'

type Handlers = {
  open(path: string): void
  renamed(from: string, to: string): void
  deleted(path: string): void
}

const files = () => window.api.files
const isNote = (e: Entry) => !e.folder && e.name.endsWith('.md')
const label = (e: Entry) => (isNote(e) ? e.name.slice(0, -3) : e.name)

// Path after `from` was renamed to `to` (unchanged when unrelated).
export const movePath = (p: string, from: string, to: string) =>
  p === from || p.startsWith(from + '/') ? to + p.slice(from.length) : p

function find(entries: Entry[], path: string): Entry | undefined {
  for (const e of entries) {
    if (e.path === path) return e
    const hit = e.children && find(e.children, path)
    if (hit) return hit
  }
}

// File tree: folders first, click a note to open it, right-click to rename or delete.
export function createExplorer(list: HTMLElement, h: Handlers) {
  let tree: Entry[] = []
  let active: string | null = null
  let renaming = false
  const expanded = new Set<string>()

  const menu = document.body.appendChild(document.createElement('div'))
  menu.className = 'menu'
  menu.hidden = true
  document.addEventListener('click', () => (menu.hidden = true))

  function render(entries: Entry[]): HTMLLIElement[] {
    return entries.map((e) => {
      const li = document.createElement('li')
      const row = li.appendChild(document.createElement('div'))
      row.className = ['row', e.folder && 'folder', expanded.has(e.path) && 'open', e.path === active && 'active', !e.folder && !isNote(e) && 'other']
        .filter(Boolean)
        .join(' ')
      row.textContent = label(e)
      row.dataset.path = e.path
      row.onclick = () => (e.folder ? toggle(e.path) : isNote(e) && open(e.path))
      row.oncontextmenu = (ev) => showMenu(ev, e, row)
      if (e.folder && expanded.has(e.path)) li.appendChild(document.createElement('ul')).append(...render(e.children!))
      return li
    })
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

  function open(path: string) {
    active = path
    h.open(path)
    redraw()
  }

  function showMenu(ev: MouseEvent, e: Entry, row: HTMLElement) {
    ev.preventDefault()
    const item = (text: string, run: () => void) => {
      const b = document.createElement('button')
      b.textContent = text
      b.onclick = run
      return b
    }
    menu.replaceChildren(item('Rename', () => startRename(e, row)), item('Delete', () => remove(e)))
    menu.style.left = `${ev.clientX}px`
    menu.style.top = `${ev.clientY}px`
    menu.hidden = false
  }

  function startRename(e: Entry, row: HTMLElement) {
    const ext = isNote(e) ? '.md' : ''
    const input = document.createElement('input')
    input.value = label(e)
    renaming = true
    row.replaceChildren(input)
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
        else {
          if (active) active = movePath(active, e.path, r.path)
          for (const p of [...expanded]) expanded.delete(p) && expanded.add(movePath(p, e.path, r.path))
          h.renamed(e.path, r.path)
        }
      }
      renaming = false
      refresh()
    }
    input.onkeydown = (k) => (k.key === 'Enter' ? finish(true) : k.key === 'Escape' && finish(false))
    input.onblur = () => finish(true)
    input.onclick = (ev) => ev.stopPropagation()
  }

  async function remove(e: Entry) {
    if (!confirm(`Delete "${label(e)}"? It will be moved to the system trash.`)) return
    if (!(await files().trash(e.path))) {
      if (!confirm(`Couldn't move "${label(e)}" to the system trash. Delete it permanently?`)) return
      await files().remove(e.path)
    }
    if (active && movePath(active, e.path, '') !== active) active = null
    h.deleted(e.path)
    refresh()
  }

  // Creates "Untitled" at the vault root and starts renaming it.
  async function create(folder: boolean) {
    const path = await files().create(folder)
    tree = await files().list()
    if (folder) redraw()
    else open(path)
    const row = list.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)
    const entry = find(tree, path)
    if (row && entry) startRename(entry, row)
  }

  files().onChange(refresh)
  refresh()
  return { create }
}
