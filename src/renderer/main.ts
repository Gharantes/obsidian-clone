import type { Api } from '../preload/index.ts'
import { showBook } from './book.ts'
import { showLibrary } from './library.ts'

declare global {
  interface Window {
    api: Api
  }
}

// Each window shows either the library or one book; switching between them reloads the window.
const root = document.getElementById('app')!
const book = await window.api.books.current()
if (book) showBook(root, book)
else showLibrary(root)
