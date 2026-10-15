import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { availablePath, inVault, listTree, renameEntry } from './files.ts'

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
})
