import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { availablePath, createEntry, inVault, listTree, moveEntry, nestNote, renameEntry } from './files.ts'

test('vault files', () => {
  const root = mkdtempSync(join(tmpdir(), 'vault-'))
  for (const d of ['b', 'a', '.obsidian']) mkdirSync(join(root, d))
  for (const f of ['note 10.md', 'note 2.md', 'a/inner.md', '.hidden.md']) writeFileSync(join(root, f), '')

  const tree = listTree(root)
  assert.deepEqual(tree.map((e) => e.path), ['a', 'b', 'note 2.md', 'note 10.md'], 'folders first, numeric order, no dot-files')
  assert.deepEqual(tree[0].children, [{ path: 'a/inner.md', name: 'inner.md', folder: false }])

  assert.throws(() => inVault(root, '../escape.md'))
  assert.throws(() => inVault(root, ''))

  writeFileSync(join(root, 'Untitled.md'), '')
  assert.equal(availablePath(root, 'Untitled', 'md'), 'Untitled 1.md')
  assert.equal(availablePath(root, 'a/Untitled', 'md'), 'a/Untitled.md')

  assert.deepEqual(renameEntry(root, 'a/inner.md', 'moved.md'), { path: 'a/moved.md' })
  assert.ok(existsSync(join(root, 'a/moved.md')))
  assert.ok('error' in renameEntry(root, 'note 2.md', 'note 10.md'), 'refuses to overwrite')
  assert.ok('error' in renameEntry(root, 'note 2.md', '../x.md'), 'refuses path separators')
  assert.ok('error' in renameEntry(root, 'note 2.md', 'what?.md'), 'refuses characters Windows forbids')
})

test('folder notes', () => {
  const root = mkdtempSync(join(tmpdir(), 'vault-'))

  // New folders come with a folder note, which the tree reports on the folder, not as a child.
  assert.equal(createEntry(root, '', true), 'Untitled')
  assert.ok(existsSync(join(root, 'Untitled/Untitled.md')))
  assert.equal(createEntry(root, 'Untitled', false), 'Untitled/Untitled 1.md')
  assert.deepEqual(listTree(root), [
    { path: 'Untitled', name: 'Untitled', folder: true, note: 'Untitled/Untitled.md', children: [{ path: 'Untitled/Untitled 1.md', name: 'Untitled 1.md', folder: false }] }
  ])

  // Renaming the folder renames its note.
  assert.deepEqual(renameEntry(root, 'Untitled', 'Chapter 1'), { path: 'Chapter 1' })
  assert.ok(existsSync(join(root, 'Chapter 1/Chapter 1.md')))

  // A note becomes a folder note so notes can be nested under it.
  writeFileSync(join(root, 'Chapter 1/Scene.md'), 'text')
  assert.deepEqual(nestNote(root, 'Chapter 1/Scene.md'), { path: 'Chapter 1/Scene/Scene.md' })
  assert.deepEqual(nestNote(root, 'Chapter 1/Scene/Scene.md'), { path: 'Chapter 1/Scene/Scene.md' }, 'already nested')
  assert.equal(listTree(root)[0].children![0].note, 'Chapter 1/Scene/Scene.md')

  // Moving.
  assert.deepEqual(moveEntry(root, 'Chapter 1/Scene', ''), { path: 'Scene' })
  assert.ok(existsSync(join(root, 'Scene/Scene.md')))
  assert.ok('error' in moveEntry(root, 'Chapter 1', 'Chapter 1'), 'not into itself')
  writeFileSync(join(root, 'Scene.md'), '')
  assert.ok('error' in moveEntry(root, 'Scene.md', 'Scene'), 'no overwriting')
})
