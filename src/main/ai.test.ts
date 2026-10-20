import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseClaudeLine, sseParser } from './ai.ts'

test('Claude Code stream-json lines', () => {
  const delta = { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } } }
  assert.deepEqual(parseClaudeLine(JSON.stringify(delta)), { text: 'Hi' })
  assert.deepEqual(parseClaudeLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Hi there' })), { final: 'Hi there' })
  assert.deepEqual(parseClaudeLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Please run /login' })), { error: 'Please run /login' })
  assert.deepEqual(parseClaudeLine(JSON.stringify({ type: 'system', subtype: 'init' })), {})
  assert.deepEqual(parseClaudeLine('not json'), {})
})

test('server-sent events split across chunks', () => {
  const got: string[] = []
  const feed = sseParser((d) => got.push(d))
  feed('data: {"a":1}\n\nda')
  feed('ta: {"b":2}\r\n')
  feed(': comment\ndata: [DONE]\n')
  assert.deepEqual(got, ['{"a":1}', '{"b":2}', '[DONE]'])
})
