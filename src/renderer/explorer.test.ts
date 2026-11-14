import { test } from 'node:test'
import assert from 'node:assert/strict'
import { movePath } from './explorer.ts'

test('paths follow renames and moves', () => {
  assert.equal(movePath('A/note.md', 'A', 'B'), 'B/note.md')
  assert.equal(movePath('A/A.md', 'A', 'B'), 'B/A.md', 'a note named like its folder keeps its name')
  assert.equal(movePath('X/A/A.md', 'X/A', 'A'), 'A/A.md', 'moving keeps the name')
  assert.equal(movePath('AB/x.md', 'A', 'B'), 'AB/x.md', 'unrelated')
  assert.equal(movePath('A/x.md', 'A', ''), '/x.md', 'deleted (any change means inside)')
})
