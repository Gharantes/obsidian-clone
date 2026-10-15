import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addVault, loadRegistry, saveRegistry, type Registry } from './vaults.ts'

test('vault registry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-'))
  const file = join(dir, 'file.md')
  writeFileSync(file, '')
  const vaults: Registry = {}

  assert.deepEqual(addVault(vaults, join(dir, 'missing')), { error: 'Folder not found' })
  assert.deepEqual(addVault(vaults, file), { error: 'Folder not found' })

  const first = addVault(vaults, dir)
  assert.ok('id' in first && first.id.length === 16)
  assert.deepEqual(addVault(vaults, dir + '/.'), first, 'same folder keeps its id')

  const registry = join(dir, 'vaults.json')
  saveRegistry(registry, vaults)
  assert.deepEqual(loadRegistry(registry), vaults)
  assert.deepEqual(loadRegistry(join(dir, 'nope.json')), {})
})
