import { h, showMenu } from './ui.ts'

// A tab can show one of the book's images instead of a note; its path is the image's name with
// this prefix (note paths always end in .md, so they never look like one).
const IMAGE = 'image:'
export const imageTab = (name: string) => IMAGE + name
export const imageName = (path: string | null) => (path?.startsWith(IMAGE) ? path.slice(IMAGE.length) : null)

// "Scene" for "Chapter 1/Scene.md" (a folder note "A/A.md" is "A"); an image tab is the image's
// name and a tab with no note is "New tab".
export function tabTitle(path: string | null): string {
  if (!path) return 'New tab'
  return imageName(path) ?? path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '')
}

// The tab to show after closing the tabs `drop` picks: the active one if it stays, else the
// nearest one left open to its right, then to its left (null when none are left).
export function nextTab<T>(tabs: T[], active: T | null, drop: (t: T) => boolean): T | null {
  if (!active || !drop(active)) return active
  const i = tabs.indexOf(active)
  return [...tabs.slice(i + 1), ...tabs.slice(0, i).reverse()].find((t) => !drop(t)) ?? null
}

// Open tabs are remembered per book in this browser, like Obsidian's workspace.
export function loadTabs(book: string): { paths: (string | null)[]; active: number } {
  try {
    const saved = JSON.parse(localStorage.getItem(`tabs:${book}`) ?? 'null')
    if (Array.isArray(saved?.paths)) return { paths: saved.paths, active: Number(saved.active) }
  } catch {}
  return { paths: [], active: -1 }
}

export function saveTabs(book: string, paths: (string | null)[], active: number) {
  try {
    localStorage.setItem(`tabs:${book}`, JSON.stringify({ paths, active }))
  } catch {}
}

type Handlers = {
  select(i: number): void
  close(i: number): void
  closeOthers(i: number): void
  closeAll(): void
  move(from: number, to: number): void
  add(): void
}

// The strip of tabs above the note: click to switch, × or middle-click to close, drag to reorder,
// right-click for more; "+" opens an empty tab.
export function createTabBar(o: Handlers) {
  const el = h('div', { class: 'tabs' })
  let dragFrom: number | null = null

  function draw(paths: (string | null)[], active: number) {
    el.replaceChildren(
      ...paths.map((p, i) => {
        const close = h('button', { textContent: '×', title: 'Close (Ctrl+W)', onclick: (ev: MouseEvent) => (ev.stopPropagation(), o.close(i)) })
        const tab = h('div', { class: `tab${i === active ? ' active' : ''}`, title: p ?? '', draggable: true }, h('span', { textContent: tabTitle(p) }), close)
        tab.onclick = () => o.select(i)
        tab.onmousedown = (ev) => ev.button === 1 && ev.preventDefault()
        tab.onauxclick = (ev) => ev.button === 1 && o.close(i)
        tab.oncontextmenu = (ev) =>
          showMenu(ev, [
            { label: 'Close', run: () => o.close(i) },
            { label: 'Close others', run: () => o.closeOthers(i) },
            { label: 'Close all', run: () => o.closeAll() }
          ])
        tab.ondragstart = (ev) => {
          dragFrom = i
          ev.dataTransfer!.effectAllowed = 'move'
          ev.dataTransfer!.setData('text/plain', p ?? '')
        }
        tab.ondragend = () => (dragFrom = null)
        tab.ondragover = (ev) => {
          if (dragFrom === null || dragFrom === i) return
          ev.preventDefault()
          tab.classList.add('drop')
        }
        tab.ondragleave = () => tab.classList.remove('drop')
        tab.ondrop = (ev) => {
          ev.preventDefault()
          if (dragFrom !== null) o.move(dragFrom, i)
          dragFrom = null
        }
        return tab
      }),
      h('button', { class: 'icon new-tab', textContent: '+', title: 'New tab (Ctrl+T)', onclick: () => o.add() })
    )
    el.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  return { el, draw }
}
