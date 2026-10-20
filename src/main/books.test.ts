import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { countNotes, createBook, readMeta, writeMeta } from './books.ts'

test('books', () => {
  const library = join(mkdtempSync(join(tmpdir(), 'lib-')), 'Books') // created on demand

  const book = createBook(library, '  My Novel ', '#123456')
  assert.deepEqual(book, { path: join(library, 'My Novel') })
  assert.deepEqual(readMeta(join(library, 'My Novel')), { color: '#123456' })
  assert.ok('error' in createBook(library, 'My Novel'), 'no duplicates')
  assert.ok('error' in createBook(library, 'a/b'), 'no path separators')

  const dir = join(library, 'My Novel')
  writeMeta(dir, { color: '#abcdef' })
  assert.equal(readMeta(dir).color, '#abcdef')
  assert.deepEqual(readMeta(join(library, 'missing')), {})

  mkdirSync(join(dir, 'Part 1'))
  for (const f of ['Part 1/Part 1.md', 'Part 1/Scene.md', 'Intro.md', 'image.png', '.hidden.md']) writeFileSync(join(dir, f), '')
  assert.equal(countNotes(dir), 3)
})
