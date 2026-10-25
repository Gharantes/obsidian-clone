import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPrompt, outline, parentNotes, parseReply, placeEdits } from './prompt.ts'

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

test('prompt marks the cursor or the selection and carries the chat', () => {
  const base = { instruction: 'make it rain', history: [], path: 'Part 1/Scene.md', doc: 'Hello world.', book: 'Novel', outline: '- Scene', parents: [{ title: 'Part 1', text: 'Summary' }] }

  const atCursor = buildPrompt({ ...base, from: 6, to: 6 })
  assert.match(atCursor, /Hello <cursor\/>world\./)
  assert.match(atCursor, /User: make it rain$/)
  assert.match(atCursor, /Book: "Novel"/)
  assert.match(atCursor, /Parent note "Part 1":\n"""\nSummary/)
  assert.doesNotMatch(atCursor, /Chat so far/)

  const selected = buildPrompt({ ...base, from: 6, to: 11, history: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'Hello!' }] })
  assert.match(selected, /Hello <selection>world<\/selection>\./)
  assert.match(selected, /Chat so far:\nUser: hi\nYou: Hello!/)
})

test('reply parsing, while streaming and when done', () => {
  assert.deepEqual(parseReply('<reply>Made it ra'), { reply: 'Made it ra', edits: [] })
  assert.deepEqual(parseReply('Just an answer.'), { reply: 'Just an answer.', edits: [] }, 'untagged text is the reply')
  const done = parseReply('<reply>Done.</reply>\n<edit><find>world</find><replace>\nrainy world\n</replace></edit>\n<edit><find>')
  assert.deepEqual(done, { reply: 'Done.', edits: [{ find: 'world', replace: 'rainy world' }] }, 'only complete edits; tag newlines dropped')
})

test('placing edits', () => {
  const doc = 'One. Two. One.'
  assert.deepEqual(placeEdits(doc, 13, 13, [{ find: 'One.', replace: '1.' }]).changes, [{ from: 10, to: 14, insert: '1.' }], 'nearest the cursor')
  assert.deepEqual(placeEdits(doc, 4, 4, [{ find: '', replace: ' Hi.' }]).changes, [{ from: 4, to: 4, insert: ' Hi.' }], 'empty find is the cursor')
  assert.deepEqual(placeEdits(doc, 5, 9, [{ find: '', replace: '2.' }]).changes, [{ from: 5, to: 9, insert: '2.' }], 'or the selection')
  const r = placeEdits(doc, 0, 0, [{ find: 'Three.', replace: '' }, { find: 'Two. One', replace: 'x' }, { find: 'One. Two', replace: 'y' }])
  assert.deepEqual(r, { changes: [{ from: 5, to: 13, insert: 'x' }], failed: 2 }, 'missing and overlapping edits fail')
})
