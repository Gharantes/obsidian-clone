import { accessSync, constants, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

export type Vault = { path: string; ts: number; open?: boolean }
export type Registry = Record<string, Vault>

// Reads the vault registry; a missing or broken file means no vaults.
export function loadRegistry(file: string): Registry {
  try {
    return JSON.parse(readFileSync(file, 'utf8')).vaults ?? {}
  } catch {
    return {}
  }
}

export function saveRegistry(file: string, vaults: Registry): void {
  writeFileSync(file, JSON.stringify({ vaults }))
}

// Registers a folder as a vault (reusing its id if known) and returns the id or an error message.
export function addVault(vaults: Registry, dir: string): { id: string } | { error: string } {
  dir = resolve(dir)
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return { error: 'Folder not found' }
  try {
    accessSync(dir, constants.R_OK | constants.W_OK)
  } catch {
    return { error: 'No permission to access folder' }
  }
  const id = Object.keys(vaults).find((k) => vaults[k].path === dir) ?? randomBytes(8).toString('hex')
  vaults[id] = { ...vaults[id], path: dir, ts: Date.now() }
  return { id }
}
