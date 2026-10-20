import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPrompt, outline, parentNotes } from './prompt.ts'

test('parent folder notes', () => {
  assert.deepEqual(parentNotes('A/B/C.md'), ['A/A.md', 'A/B/B.md'])
  assert.deepEqual(parentNotes('A/B/B.md'), ['A/A.md'], "a folder note's own folder is not a parent")
  assert.deepEqual(parentNotes('Top.md'), [])
})

test('book outline', () => {
  const tree = [
    { path: 'Part 1', name: 'Part 1', folder: true, note: 'Part 1/Part 1.md', children: [{ path: 'Part 1/Scene.md', name: 'Scene.md', folder: false }] },
    { path: 'cover.png', name: 'cover.png', folder: false },
    { path: 'Ideas.md', name: 'Ideas.md', folder: false }
  ]
  assert.equal(outline(tree, 'Part 1/Part 1.md'), '- Part 1 (current note)\n  - Scene\n- Ideas')
})

test('prompt marks the cursor or the selection', () => {
  const base = { instruction: 'make it rain', path: 'Part 1/Scene.md', doc: 'Hello world.', book: 'Novel', outline: '- Scene', parents: [{ title: 'Part 1', text: 'Summary' }] }

  const write = buildPrompt({ ...base, mode: 'write', from: 6, to: 6 })
  assert.match(write, /Hello <cursor\/>world\./)
  assert.match(write, /Instruction: make it rain/)
  assert.match(write, /Book: "Novel"/)
  assert.match(write, /Parent note "Part 1":\n"""\nSummary/)

  const rewrite = buildPrompt({ ...base, mode: 'rewrite', from: 6, to: 11 })
  assert.match(rewrite, /Hello <selection>world<\/selection>\./)
  assert.match(rewrite, /Rewrite the text inside <selection>/)

  const cont = buildPrompt({ ...base, mode: 'continue', instruction: '', from: 12, to: 12 })
  assert.match(cont, /Continue writing from <cursor\/>/)
  assert.doesNotMatch(cont, /Guidance/)
})
