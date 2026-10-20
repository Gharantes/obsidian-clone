import type { Settings } from './api.ts'
import { h, modal } from './ui.ts'

const { api } = window

// OpenAI-compatible endpoints with a free tier or local models (see FREE_AI_OPTIONS.md).
export const PRESETS: { name: string; baseUrl: string; model: string; key: string }[] = [
  { name: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2', key: 'not needed' },
  { name: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', model: 'local-model', key: 'not needed' },
  { name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash', key: 'aistudio.google.com/apikey' },
  { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', key: 'console.groq.com/keys' },
  { name: 'OpenRouter (free models)', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/free', key: 'openrouter.ai/keys' },
  { name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', key: 'console.mistral.ai' },
  { name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', model: 'gpt-oss-120b', key: 'cloud.cerebras.ai' },
  { name: 'GitHub Models', baseUrl: 'https://models.github.ai/inference', model: 'openai/gpt-4.1-mini', key: 'a GitHub token with models:read' }
]

const field = (label: string, ...control: (Node | string)[]) => h('label', { class: 'field' }, h('span', { textContent: label }), ...control)

// Settings dialog: the AI writing and image providers.
export async function openSettings(): Promise<void> {
  let s: Settings = await api.settings.get()

  const provider = h('select', {}, h('option', { value: 'claude-code', textContent: 'Claude Code (uses your Claude subscription)' }), h('option', { value: 'openai', textContent: 'OpenAI-compatible API (Ollama, Gemini, Groq, …)' }))
  provider.value = s.ai.provider

  const claudePath = h('input', { value: s.ai.claudePath, placeholder: 'Detecting…' })
  api.ai.detectClaude().then((p) => (claudePath.placeholder = p ? `Auto-detect: ${p}` : 'Not found — install Claude Code or enter its path'))
  const models = h('datalist', { id: 'claude-models' }, ...['sonnet', 'opus', 'haiku'].map((m) => h('option', { value: m })))
  const claudeModel = h('input', { value: s.ai.claudeModel, placeholder: 'Claude Code default' })
  claudeModel.setAttribute('list', 'claude-models')
  const claude = h('fieldset', {},
    field('Executable', claudePath),
    field('Model', claudeModel, models),
    h('p', { class: 'hint', textContent: 'Runs `claude -p` with no tools. Log in once by running `claude` in a terminal.' })
  )

  const preset = h('select', {}, h('option', { value: '', textContent: 'Fill in from a preset…' }), ...PRESETS.map((p, i) => h('option', { value: String(i), textContent: p.name })))
  const baseUrl = h('input', { value: s.ai.openai.baseUrl })
  const model = h('input', { value: s.ai.openai.model })
  const apiKey = h('input', { type: 'password', value: s.ai.openai.apiKey, placeholder: 'Leave empty for local servers' })
  const keyHint = h('p', { class: 'hint' })
  preset.onchange = () => {
    const p = PRESETS[Number(preset.value)]
    if (!p) return
    baseUrl.value = p.baseUrl
    model.value = p.model
    keyHint.textContent = `API key: ${p.key}`
  }
  const openai = h('fieldset', {}, field('Preset', preset), field('Base URL', baseUrl), field('Model', model), field('API key', apiKey), keyHint)

  const imageProvider = h('select', {},
    h('option', { value: 'pollinations', textContent: 'Pollinations (free, no key, small watermark)' }),
    h('option', { value: 'openai', textContent: 'OpenAI-compatible server (stable-diffusion.cpp, LocalAI, …)' })
  )
  imageProvider.value = s.image.provider
  const imageUrl = h('input', { value: s.image.openai.baseUrl })
  const imageModel = h('input', { value: s.image.openai.model, placeholder: "Server's default" })
  const imageKey = h('input', { type: 'password', value: s.image.openai.apiKey, placeholder: 'Leave empty for local servers' })
  const imageOpenai = h('fieldset', {},
    field('Base URL', imageUrl),
    field('Model', imageModel),
    field('API key', imageKey),
    h('p', { class: 'hint', textContent: 'Calls POST <base URL>/images/generations, e.g. `sd-server --listen-port 8080` from stable-diffusion.cpp.' })
  )

  const sync = () => {
    claude.hidden = provider.value !== 'claude-code'
    openai.hidden = provider.value !== 'openai'
    imageOpenai.hidden = imageProvider.value !== 'openai'
  }
  provider.onchange = sync
  imageProvider.onchange = sync
  sync()

  const collect = (): Settings => ({
    ...s,
    ai: {
      provider: provider.value as Settings['ai']['provider'],
      claudePath: claudePath.value.trim(),
      claudeModel: claudeModel.value.trim(),
      openai: { baseUrl: baseUrl.value.trim(), model: model.value.trim(), apiKey: apiKey.value.trim() }
    },
    image: {
      provider: imageProvider.value as Settings['image']['provider'],
      openai: { baseUrl: imageUrl.value.trim(), model: imageModel.value.trim(), apiKey: imageKey.value.trim() }
    }
  })

  const result = h('p', { class: 'hint' })
  const test = h('button', {
    textContent: 'Test',
    onclick: async () => {
      s = await api.settings.set(collect())
      result.className = 'hint'
      result.textContent = 'Testing…'
      test.disabled = true
      const r = await api.ai.test()
      test.disabled = false
      result.className = 'error' in r ? 'error' : 'hint ok'
      result.textContent = 'error' in r ? r.error : `✓ ${r.text.trim()}`
    }
  })

  const dlg = modal(
    'Settings',
    [
      h('h3', { textContent: 'AI writing' }),
      field('Provider', provider),
      claude,
      openai,
      h('div', { class: 'row-input' }, test, result),
      h('h3', { textContent: 'Images' }),
      field('Provider', imageProvider),
      imageOpenai
    ],
    [
      h('button', { textContent: 'Cancel', onclick: () => dlg.close() }),
      h('button', { class: 'primary', textContent: 'Save', onclick: async () => (await api.settings.set(collect()), dlg.close()) })
    ]
  )
  dlg.box.classList.add('settings')
}
