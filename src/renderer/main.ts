import { EditorView, basicSetup } from 'codemirror'
import { markdown } from '@codemirror/lang-markdown'

new EditorView({
  doc: '# Hello\n\nThis is a **Markdown** editor.\n',
  extensions: [basicSetup, markdown(), EditorView.lineWrapping],
  parent: document.getElementById('editor')!
})
