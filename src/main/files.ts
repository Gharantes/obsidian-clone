import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

// Folders carry `note` when they have a folder note ("X/X.md"); that note is left out of `children`.
export type Entry = { path: string; name: string; folder: boolean; note?: string; children?: Entry[] }

const byFolderThenName = (a: Entry, b: Entry) =>
  Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name, undefined, { numeric: true })

const baseName = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1)
const parentOf = (rel: string) => rel.slice(0, Math.max(0, rel.lastIndexOf('/')))
const joinRel = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)

// Path of a folder's folder note: "A/B" -> "A/B/B.md".
export const folderNotePath = (folder: string) => `${folder}/${baseName(folder)}.md`

// Lists a vault folder recursively, skipping dot-files; paths are vault-relative with '/'.
export function listTree(root: string, dir = ''): Entry[] {
  return readdirSync(join(root, dir), { withFileTypes: true })
    .filter((d) => !d.name.startsWith('.') && (d.isDirectory() || d.isFile()))
    .map((d): Entry => {
      const path = joinRel(dir, d.name)
      if (!d.isDirectory()) return { path, name: d.name, folder: false }
      const children = listTree(root, path)
      const entry: Entry = { path, name: d.name, folder: true, children }
      const i = children.findIndex((c) => !c.folder && c.name === `${d.name}.md`)
      if (i >= 0) entry.note = children.splice(i, 1)[0].path
      return entry
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

// Error message for a file or folder name that can't be used, or null.
export function badName(name: string): string | null {
  if (!name || name.startsWith('.') || /[\\/:*?"<>|]/.test(name))
    return 'Names cannot be empty, start with "." or contain \\ / : * ? " < > |'
  return null
}

// Creates "Untitled" in `parent` ('' = root). Folders get a folder note. Returns the new path.
export function createEntry(root: string, parent: string, folder: boolean): string {
  const path = availablePath(root, joinRel(parent, 'Untitled'), folder ? '' : 'md')
  if (folder) {
    mkdirSync(inVault(root, path))
    writeFileSync(inVault(root, folderNotePath(path)), '')
  } else writeFileSync(inVault(root, path), '')
  return path
}

// Renames an entry inside its folder; returns the new vault-relative path or an error message.
// Renaming a folder renames its folder note along with it.
export function renameEntry(root: string, rel: string, newName: string): { path: string } | { error: string } {
  newName = newName.trim()
  const bad = badName(newName)
  if (bad) return { error: bad }
  const path = joinRel(parentOf(rel), newName)
  if (path === rel) return { path }
  // A case-only rename finds the old entry on case-insensitive filesystems; that's fine.
  if (path.toLowerCase() !== rel.toLowerCase() && existsSync(inVault(root, path)))
    return { error: `"${newName}" already exists` }
  renameSync(inVault(root, rel), inVault(root, path))
  const oldNote = `${path}/${baseName(rel)}.md`
  if (existsSync(inVault(root, oldNote)) && !existsSync(inVault(root, folderNotePath(path))))
    renameSync(inVault(root, oldNote), inVault(root, folderNotePath(path)))
  return { path }
}

// Turns note "A/B.md" into the folder note "A/B/B.md" so notes can go inside it. Returns its new path.
export function nestNote(root: string, rel: string): { path: string } | { error: string } {
  if (!rel.endsWith('.md')) return { error: 'Only notes can hold other notes' }
  const folder = rel.slice(0, -3)
  if (baseName(parentOf(rel)) === baseName(folder)) return { path: rel } // already a folder note
  const target = folderNotePath(folder)
  if (existsSync(inVault(root, target))) return { error: `"${target}" already exists` }
  mkdirSync(inVault(root, folder), { recursive: true })
  renameSync(inVault(root, rel), inVault(root, target))
  return { path: target }
}

// Moves an entry into `dest` ('' = root). Returns the new path or an error message.
export function moveEntry(root: string, rel: string, dest: string): { path: string } | { error: string } {
  if (dest === rel || dest.startsWith(rel + '/')) return { error: 'Cannot move a folder into itself' }
  const path = joinRel(dest, baseName(rel))
  if (path === rel) return { path }
  if (existsSync(inVault(root, path))) return { error: `"${baseName(rel)}" already exists there` }
  renameSync(inVault(root, rel), inVault(root, path))
  return { path }
}
