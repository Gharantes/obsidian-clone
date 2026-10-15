import { existsSync, readdirSync, renameSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

export type Entry = { path: string; name: string; folder: boolean; children?: Entry[] }

const byFolderThenName = (a: Entry, b: Entry) =>
  Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name, undefined, { numeric: true })

// Lists a vault folder recursively, skipping dot-files; paths are vault-relative with '/'.
export function listTree(root: string, dir = ''): Entry[] {
  return readdirSync(join(root, dir), { withFileTypes: true })
    .filter((d) => !d.name.startsWith('.') && (d.isDirectory() || d.isFile()))
    .map((d): Entry => {
      const path = dir ? `${dir}/${d.name}` : d.name
      if (!d.isDirectory()) return { path, name: d.name, folder: false }
      return { path, name: d.name, folder: true, children: listTree(root, path) }
    })
    .sort(byFolderThenName)
}

// Resolves a vault-relative path, refusing the vault root and anything outside it.
export function inVault(root: string, rel: string): string {
  const full = resolve(root, rel)
  if (!full.startsWith(root + sep)) throw new Error(`Path outside vault: ${rel}`)
  return full
}

// First free "base.ext", "base 1.ext", ... (ext '' for folders), as a vault-relative path.
export function availablePath(root: string, base: string, ext: string): string {
  const name = (n: number) => (n ? `${base} ${n}` : base) + (ext ? `.${ext}` : '')
  let n = 0
  while (existsSync(inVault(root, name(n)))) n++
  return name(n)
}

// Renames an entry inside its folder; returns the new vault-relative path or an error message.
export function renameEntry(root: string, rel: string, newName: string): { path: string } | { error: string } {
  newName = newName.trim()
  if (!newName || newName.startsWith('.') || /[\\/:]/.test(newName))
    return { error: 'Names cannot be empty, start with "." or contain \\ / :' }
  const path = rel.slice(0, rel.lastIndexOf('/') + 1) + newName
  if (path === rel) return { path }
  if (existsSync(inVault(root, path))) return { error: `"${newName}" already exists` }
  renameSync(inVault(root, rel), inVault(root, path))
  return { path }
}
