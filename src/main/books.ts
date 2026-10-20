import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { badName } from './files.ts'

// A book is a vault folder; its cover settings live in a dot-file the file tree skips.
export type BookMeta = { color?: string }
const META = '.book.json'

export const COVERS = ['#7c4dff', '#e5484d', '#f76b15', '#ffc53d', '#30a46c', '#12a594', '#0090ff', '#3e63dd', '#d6409f', '#6f6e77']

export function readMeta(dir: string): BookMeta {
  try {
    return JSON.parse(readFileSync(join(dir, META), 'utf8'))
  } catch {
    return {}
  }
}

export function writeMeta(dir: string, meta: BookMeta): void {
  writeFileSync(join(dir, META), JSON.stringify(meta))
}

// Creates a book folder inside the library; returns its full path or an error message.
export function createBook(library: string, title: string, color?: string): { path: string } | { error: string } {
  title = title.trim()
  const bad = badName(title)
  if (bad) return { error: bad }
  const path = join(library, title)
  if (existsSync(path)) return { error: `A book called "${title}" already exists` }
  mkdirSync(path, { recursive: true })
  writeMeta(path, { color: color ?? COVERS[Math.floor(Math.random() * COVERS.length)] })
  return { path }
}

// Number of Markdown notes in a folder tree (dot-files skipped).
export function countNotes(dir: string): number {
  let n = 0
  try {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.name.startsWith('.')) continue
      if (d.isDirectory()) n += countNotes(join(dir, d.name))
      else if (d.name.endsWith('.md')) n++
    }
  } catch {}
  return n
}
