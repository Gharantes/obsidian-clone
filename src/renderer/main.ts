// Sets window.api; imported first because other modules use it as they load.
import './api.ts'
import { showBook } from './book.ts'
import { showLibrary } from './library.ts'

// Each window shows either the library or one book; switching between them reloads the window.
const root = document.getElementById('app')!
const book = await window.api.books.current()
if (book) showBook(root, book)
else showLibrary(root)
