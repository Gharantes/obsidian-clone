import { EditorView, basicSetup } from 'codemirror'
import { markdown } from '@codemirror/lang-markdown'
import type { Api } from '../preload/index.ts'

declare global {
  interface Window {
    api: Api
  }
}

const { api } = window
const root = document.getElementById('app')!
const folderName = (path: string) => path.split(/[\\/]/).pop() || path

function showEditor(path: string): void {
  document.title = folderName(path)
  new EditorView({
    doc: '# Hello\n\nThis is a **Markdown** editor.\n',
    extensions: [basicSetup, markdown(), EditorView.lineWrapping],
    parent: root
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
if (vault) showEditor(vault.path)
else showPicker()
