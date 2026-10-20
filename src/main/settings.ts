import { readFileSync, writeFileSync } from 'node:fs'

export type Provider = 'claude-code' | 'openai'

export type Settings = {
  // Where new books are created; defaults to Documents/Books.
  library?: string
  ai: {
    provider: Provider
    // Claude Code executable; empty means auto-detect.
    claudePath: string
    // Model alias or full id passed to `claude --model`; empty uses Claude Code's default.
    claudeModel: string
    // Any OpenAI-compatible /chat/completions endpoint (Ollama, Groq, OpenRouter, Gemini, ...).
    openai: { baseUrl: string; model: string; apiKey: string }
  }
}

export const defaults = (): Settings => ({
  ai: {
    provider: 'claude-code',
    claudePath: '',
    claudeModel: 'sonnet',
    openai: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.2', apiKey: '' }
  }
})

// Reads settings over the defaults; a missing or broken file means defaults.
export function loadSettings(file: string): Settings {
  const s = defaults()
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    return { ...s, ...saved, ai: { ...s.ai, ...saved.ai, openai: { ...s.ai.openai, ...saved.ai?.openai } } }
  } catch {
    return s
  }
}

export function saveSettings(file: string, s: Settings): void {
  writeFileSync(file, JSON.stringify(s, null, 2))
}
