import { EditorView, basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import type { Api } from '../preload/index.ts'
import { createExplorer, movePath } from './explorer.ts'

declare global {
  interface Window {
    api: Api
  }
}

const { api } = window
const root = document.getElementById('app')!
const folderName = (path: string) => path.split(/[\\/]/).pop() || path

// One editor for the open note; edits autosave 500 ms after the last change.
function createEditor(pane: HTMLElement) {
  let current: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const save = () => {
    clearTimeout(timer)
    timer = undefined
    if (current) api.files.write(current, view.state.doc.toString())
  }
  const extensions = [
    basicSetup,
    markdown(),
    EditorView.lineWrapping,
    EditorView.updateListener.of((u) => {
      if (!u.docChanged) return
      clearTimeout(timer)
      timer = setTimeout(save, 500)
    })
  ]
  const view = new EditorView({ parent: pane })

  async function open(path: string | null) {
    if (timer) save()
    current = path
    view.setState(EditorState.create({ doc: path ? await api.files.read(path) : '', extensions }))
    pane.classList.toggle('empty', !path)
  }

  return {
    open,
    renamed: (from: string, to: string) => current && (current = movePath(current, from, to)),
    deleted(path: string) {
      if (!current || movePath(current, path, '') === current) return
      clearTimeout(timer)
      timer = undefined
      open(null)
    }
  }
}

function showVault(path: string): void {
  document.title = folderName(path)
  root.className = 'vault'
  root.innerHTML = `
    <nav>
      <div class="actions"><button data-new="note">New note</button><button data-new="folder">New folder</button></div>
      <ul class="tree"></ul>
    </nav>
    <main class="empty"><p class="placeholder">No file is open</p></main>`
  const editor = createEditor(root.querySelector('main')!)
  const explorer = createExplorer(root.querySelector('.tree')!, editor)
  root.querySelectorAll<HTMLButtonElement>('[data-new]').forEach((b) => {
    b.onclick = () => explorer.create(b.dataset.new === 'folder')
  })
}

// Vault picker: open a folder, or reopen a recent vault.
async function showPicker(): Promise<void> {
  root.className = 'picker'
  root.innerHTML = '<h1>Obsidian Clone</h1><button id="pick">Open folder as vault</button><p class="error"></p><ul></ul>'
  const error = root.querySelector('.error')!
  const report = (msg: string | null) => (error.textContent = msg ?? '')

  root.querySelector('#pick')!.addEventListener('click', async () => report(await api.pickVault()))
  for (const v of await api.listVaults()) {
    const li = root.querySelector('ul')!.appendChild(document.createElement('li'))
    li.innerHTML = '<b></b><small></small>'
    li.querySelector('b')!.textContent = folderName(v.path)
    li.querySelector('small')!.textContent = v.path
    li.addEventListener('click', async () => report(await api.openVault(v.path)))
  }
}

const vault = await api.currentVault()
if (vault) showVault(vault.path)
else showPicker()
