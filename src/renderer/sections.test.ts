import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isFolderNote, parseSections, serializeSections, type Section } from './sections.ts'

test('sections round-trip through the folder note', () => {
  const sections: Section[] = [{ kind: 'text', text: '# Part 1\n\nIntro.\n' }, { kind: 'index' }, { kind: 'text', text: '' }]
  assert.deepEqual(parseSections(serializeSections(sections)), sections)
  assert.deepEqual(parseSections(''), [], 'a new folder has no sections')
  assert.deepEqual(parseSections('Old text'), [{ kind: 'text', text: 'Old text' }], 'older folder notes become one text section')
})

test('folder notes', () => {
  assert.ok(isFolderNote('A/B/B.md'))
  assert.ok(!isFolderNote('A/B.md'))
  assert.ok(!isFolderNote('B.md'))
})
