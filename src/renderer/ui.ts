// Small DOM helpers shared by the library and book pages.

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const { class: cls, ...rest } = props
  const el = Object.assign(document.createElement(tag), rest)
  if (cls) el.className = cls
  el.append(...children)
  return el
}

export type MenuItem = { label: string; run: () => void; danger?: boolean } | '-'

let menuEl: HTMLDivElement | undefined

// The one context menu element, created on first use; any click, Escape or blur hides it.
function getMenu(): HTMLDivElement {
  if (menuEl) return menuEl
  const menu = (menuEl = document.body.appendChild(h('div', { class: 'menu', hidden: true })))
  document.addEventListener('click', () => (menu.hidden = true))
  document.addEventListener('keydown', (k) => k.key === 'Escape' && (menu.hidden = true))
  window.addEventListener('blur', () => (menu.hidden = true))
  return menu
}

// Context menu at the mouse position.
export function showMenu(ev: MouseEvent, items: MenuItem[]): void {
  ev.preventDefault()
  ev.stopPropagation()
  const menu = getMenu()
  menu.replaceChildren(
    ...items.map((i) =>
      i === '-' ? h('hr') : h('button', { class: i.danger ? 'danger' : '', textContent: i.label, onclick: () => ((menu.hidden = true), i.run()) })
    )
  )
  menu.hidden = false
  // Keep it on screen.
  const { innerWidth: w, innerHeight: ht } = window
  const r = menu.getBoundingClientRect()
  menu.style.left = `${Math.min(ev.clientX, w - r.width - 4)}px`
  menu.style.top = `${Math.min(ev.clientY, ht - r.height - 4)}px`
}

// Modal dialog with a title, body and footer buttons. Escape or a click outside closes it.
export function modal(title: string, body: Node[], footer: HTMLElement[], onClose?: () => void) {
  const box = h('div', { class: 'dialog' }, h('h2', { textContent: title }), ...body, h('footer', {}, ...footer))
  const backdrop = h('div', { class: 'backdrop' }, box)
  const close = () => {
    if (!backdrop.isConnected) return
    backdrop.remove()
    document.removeEventListener('keydown', onKey)
    onClose?.()
  }
  const onKey = (k: KeyboardEvent) => k.key === 'Escape' && close()
  backdrop.onmousedown = (ev) => ev.target === backdrop && close()
  document.addEventListener('keydown', onKey)
  document.body.append(backdrop)
  return { box, close }
}

// Asks for one line of text; resolves to the trimmed text, or null when cancelled.
// `check` may return an error message to keep the dialog open.
export function ask(
  title: string,
  opts: { value?: string; placeholder?: string; ok?: string; check?: (v: string) => Promise<string | null> } = {}
): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('input', { value: opts.value ?? '', placeholder: opts.placeholder ?? '' })
    const error = h('p', { class: 'error' })
    let result: string | null = null
    const submit = async () => {
      const v = input.value.trim()
      if (!v) return
      const err = opts.check ? await opts.check(v) : null
      if (err) return void (error.textContent = err)
      result = v
      dlg.close()
    }
    const ok = h('button', { class: 'primary', textContent: opts.ok ?? 'OK', onclick: submit })
    const cancel = h('button', { textContent: 'Cancel', onclick: () => dlg.close() })
    const dlg = modal(title, [input, error], [cancel, ok], () => resolve(result))
    input.onkeydown = (k) => k.key === 'Enter' && submit()
    input.focus()
    input.select()
  })
}

// "3 days ago"-style relative time.
export function ago(ts: number): string {
  const s = (Date.now() - ts) / 1000
  const units: [number, string][] = [[31536000, 'year'], [2592000, 'month'], [86400, 'day'], [3600, 'hour'], [60, 'minute']]
  for (const [n, u] of units) if (s >= n) return `${Math.floor(s / n)} ${u}${s >= 2 * n ? 's' : ''} ago`
  return 'just now'
}
