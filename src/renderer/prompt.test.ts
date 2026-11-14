import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPrompt, endSeparator, mentioned, noteName, notePaths, outline, parseReply, placeEdits } from './prompt.ts'

test('book outline', () => {
  const tree = [
    { path: 'Part 1', name: 'Part 1', folder: true, children: [{ path: 'Part 1/Scene.md', name: 'Scene.md', folder: false }] },
    { path: 'cover.png', name: 'cover.png', folder: false },
    { path: 'Ideas.md', name: 'Ideas.md', folder: false }
  ]
  assert.equal(outline(tree, 'Part 1/Scene.md'), '- Part 1/\n  - Part 1/Scene.md (open)\n- Ideas.md')
  assert.equal(outline(tree, null), '- Part 1/\n  - Part 1/Scene.md\n- Ideas.md')
})

test('notes the chat points at', () => {
  const tree = [
    { path: 'Part 1', name: 'Part 1', folder: true, children: [{ path: 'Part 1/Mira.md', name: 'Mira.md', folder: false }] },
    { path: 'Ideas.md', name: 'Ideas.md', folder: false },
    { path: 'Al.md', name: 'Al.md', folder: false }
  ]
  assert.deepEqual(notePaths(tree), ['Part 1/Mira.md', 'Ideas.md', 'Al.md'])
  assert.equal(noteName('Part 1/Part 1.md'), 'Part 1/Part 1', 'a note named like its folder is an ordinary note')
  assert.deepEqual(mentioned('fix [[Part 1/Mira]] and [[ideas.md]]', tree), ['Part 1/Mira.md', 'Ideas.md'], 'links by path')
  assert.deepEqual(mentioned('make mira braver', tree), ['Part 1/Mira.md'], 'titles written out')
  assert.deepEqual(mentioned('a Mirage and Al', tree), [], 'whole words, three letters or more')
})

test('prompt marks the cursor or the selection and carries the chat', () => {
  const base = { instruction: 'make it rain', history: [], path: 'Part 1/Scene.md', doc: 'Hello world.', book: 'Novel', outline: '- Scene', notes: [] }

  const atCursor = buildPrompt({ ...base, from: 6, to: 6 })
  assert.match(atCursor, /Hello <cursor\/>world\./)
  assert.match(atCursor, /User: make it rain$/)
  assert.match(atCursor, /Book: "Novel"/)
  assert.doesNotMatch(atCursor, /Chat so far/)

  const selected = buildPrompt({ ...base, from: 6, to: 11, history: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'Hello!' }] })
  assert.match(selected, /Hello <selection>world<\/selection>\./)
  assert.match(selected, /Chat so far:\nUser: hi\nYou: Hello!/)

  const none = buildPrompt({ ...base, path: null, doc: '', from: 0, to: 0, notes: [{ path: 'Mira.md', text: 'Brave.' }], history: [{ role: 'assistant', text: 'Made it.', notes: ['Mira.md'] }] })
  assert.match(none, /No note is open\./)
  assert.match(none, /Note "Mira\.md":\n"""\nBrave\./)
  assert.match(none, /You: Made it\. \(changed Mira\.md\)/)
  assert.doesNotMatch(none, /<cursor\/>/)
})

test('reply parsing, while streaming and when done', () => {
  assert.deepEqual(parseReply('<reply>Made it ra'), { reply: 'Made it ra', edits: [] })
  assert.deepEqual(parseReply('Just an answer.'), { reply: 'Just an answer.', edits: [] }, 'untagged text is the reply')
  const done = parseReply('<reply>Done.</reply>\n<edit><find>world</find><replace>\nrainy world\n</replace></edit>\n<edit><find>')
  assert.deepEqual(done, { reply: 'Done.', edits: [{ find: 'world', replace: 'rainy world' }] }, 'only complete edits; tag newlines dropped')

  const notes = parseReply('<reply>Ok.</reply><edit note="/Part 1/Mira"><find>a</find><replace>b</replace></edit><create note="Part 2/Arrival.md">\nNew.\n</create><create>no path</create>')
  assert.deepEqual(notes.edits, [
    { find: 'a', replace: 'b', note: 'Part 1/Mira.md' },
    { find: '', replace: 'New.', note: 'Part 2/Arrival.md', create: true }
  ], 'other notes and new ones, by path')
  assert.equal(parseReply('<create note="x.md">Hal').reply, '', 'a change still streaming is not the reply')
})

test('adding to the end of a note', () => {
  assert.equal(endSeparator(''), '')
  assert.equal(endSeparator('Text.'), '\n\n')
  assert.equal(endSeparator('Text.\n'), '\n')
})

test('placing edits', () => {
  const doc = 'One. Two. One.'
  assert.deepEqual(placeEdits(doc, 13, 13, [{ find: 'One.', replace: '1.' }]).changes, [{ from: 10, to: 14, insert: '1.' }], 'nearest the cursor')
  assert.deepEqual(placeEdits(doc, 4, 4, [{ find: '', replace: ' Hi.' }]).changes, [{ from: 4, to: 4, insert: ' Hi.' }], 'empty find is the cursor')
  assert.deepEqual(placeEdits(doc, 5, 9, [{ find: '', replace: '2.' }]).changes, [{ from: 5, to: 9, insert: '2.' }], 'or the selection')
  const r = placeEdits(doc, 0, 0, [{ find: 'Three.', replace: '' }, { find: 'Two. One', replace: 'x' }, { find: 'One. Two', replace: 'y' }])
  assert.deepEqual(r, { changes: [{ from: 5, to: 13, insert: 'x' }], failed: 2 }, 'missing and overlapping edits fail')
})
