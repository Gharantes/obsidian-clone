import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Settings } from './settings.ts'

export type Generate = (prompt: string, system: string, onText: (t: string) => void, signal: AbortSignal) => Promise<void>

const win = process.platform === 'win32'
const exe = win ? 'claude.exe' : 'claude'

// Newest "x.y.z" first.
const byVersionDesc = (a: string, b: string) => b.localeCompare(a, undefined, { numeric: true })

// Claude Code executables worth trying, most likely first: PATH, the native installer, then
// the binary bundled with the VS Code (and fork) extension.
async function candidates(): Promise<string[]> {
  const home = homedir()
  const onPath = await new Promise<string[]>((done) =>
    execFile(win ? 'where.exe' : 'which', win ? ['claude'] : ['-a', 'claude'], (err, out) =>
      done(err ? [] : out.split(/\r?\n/).filter(Boolean))
    )
  )
  // `where` lists the extensionless npm shim too; only .exe/.cmd can be started on Windows.
  const paths = win ? onPath.filter((p) => /\.(exe|cmd)$/i.test(p)).sort((a) => (/\.exe$/i.test(a) ? -1 : 1)) : onPath
  paths.push(join(home, '.local', 'bin', exe), join(home, '.claude', 'local', exe))
  if (!win) paths.push('/opt/homebrew/bin/claude', '/usr/local/bin/claude')
  for (const editor of ['.vscode', '.vscode-insiders', '.cursor', '.windsurf']) {
    const dir = join(home, editor, 'extensions')
    let names: string[] = []
    try {
      names = readdirSync(dir).filter((n) => n.startsWith('anthropic.claude-code-'))
    } catch {}
    for (const n of names.sort(byVersionDesc)) paths.push(join(dir, n, 'resources', 'native-binary', exe))
  }
  return paths
}

// The configured Claude Code executable if it exists, else the first one found.
export async function findClaude(configured: string): Promise<string | null> {
  if (configured) return existsSync(configured) ? configured : null
  return (await candidates()).find((p) => existsSync(p)) ?? null
}

export type ClaudeEvent = { text?: string; final?: string; error?: string }

// Reads one line of `claude --output-format stream-json --include-partial-messages`.
export function parseClaudeLine(line: string): ClaudeEvent {
  let ev: any
  try {
    ev = JSON.parse(line)
  } catch {
    return {}
  }
  if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta')
    return { text: ev.event.delta.text }
  if (ev.type === 'result') {
    if (ev.is_error || ev.subtype !== 'success')
      return { error: String(ev.result || ev.errors?.join('\n') || ev.subtype || 'Claude Code failed') }
    return { final: String(ev.result ?? '') }
  }
  return {}
}

// .cmd shims need a shell on Windows; quote everything for it (our args have no quotes).
const quote = (s: string) => `"${s}"`

// Runs Claude Code headless with no tools, feeding the prompt on stdin and streaming the reply.
export function claudeCode(path: string, model: string, workdir: string): Generate {
  return (prompt, system, onText, signal) =>
    new Promise((resolve, reject) => {
      mkdirSync(workdir, { recursive: true })
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence',
        '--system-prompt', system]
      if (model) args.push('--model', model)
      const shell = win && /\.cmd$/i.test(path)
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.CLAUDECODE
      const child = shell
        ? spawn(quote(path), args.map(quote), { cwd: workdir, env, shell: true, windowsHide: true })
        : spawn(path, args, { cwd: workdir, env, windowsHide: true })

      let streamed = false
      let error = ''
      let stderr = ''
      let buf = ''
      const handle = (line: string) => {
        const ev = parseClaudeLine(line)
        if (ev.text) {
          streamed = true
          onText(ev.text)
        }
        if (ev.final && !streamed) onText(ev.final) // CLI without partial messages
        if (ev.error) error = ev.error
      }
      child.stdout.setEncoding('utf8').on('data', (d: string) => {
        buf += d
        const lines = buf.split('\n')
        buf = lines.pop()!
        lines.forEach(handle)
      })
      child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))

      const kill = () => {
        if (win && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        else child.kill()
      }
      signal.addEventListener('abort', kill, { once: true })
      child.on('error', (e) => reject(new Error(`Could not start Claude Code (${path}): ${e.message}`)))
      child.on('close', (code) => {
        signal.removeEventListener('abort', kill)
        if (buf) handle(buf)
        if (signal.aborted) resolve()
        else if (error) reject(new Error(error))
        else if (code) reject(new Error(stderr.trim() || `Claude Code exited with code ${code}`))
        else resolve()
      })
      child.stdin.on('error', () => {}) // the process may exit before reading everything
      child.stdin.end(prompt)
    })
}

// Splits a Server-Sent Events stream into `data:` payloads; feed it chunks, it calls onData.
export function sseParser(onData: (data: string) => void) {
  let buf = ''
  return (chunk: string) => {
    buf += chunk
    const lines = buf.split(/\r?\n/)
    buf = lines.pop()!
    for (const l of lines) if (l.startsWith('data:')) onData(l.slice(5).trim())
  }
}

// Streams from any OpenAI-compatible /chat/completions endpoint.
export function openaiCompatible(cfg: Settings['ai']['openai']): Generate {
  return async (prompt, system, onText, signal) => {
    const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', ...(cfg.apiKey && { authorization: `Bearer ${cfg.apiKey}` }) },
      body: JSON.stringify({
        model: cfg.model,
        stream: true,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt }
        ]
      })
    }).catch((e) => {
      if (signal.aborted) return null
      const why = e.cause?.code || e.cause?.message || e.message
      throw new Error(`Could not reach ${cfg.baseUrl} (${why}). Is the server running and the URL right?`)
    })
    if (!res) return
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 500)}`)

    const feed = sseParser((data) => {
      if (data === '[DONE]') return
      try {
        const json = JSON.parse(data)
        if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error))
        const text = json.choices?.[0]?.delta?.content
        if (text) onText(text)
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e
      }
    })
    const decoder = new TextDecoder()
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) feed(decoder.decode(chunk, { stream: true }))
    } catch (e) {
      if (!signal.aborted) throw e
    }
  }
}
