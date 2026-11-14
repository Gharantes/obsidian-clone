import type { ApiConfig, Settings } from './api.ts'
import { parseReply } from './prompt.ts'
import { h, modal } from './ui.ts'

const { api } = window

// OpenAI-compatible APIs, each with its own section in Settings (see FREE_AI_OPTIONS.md).
// `models` are the ids to pick from in the sidebar, the first being the default; checked 2026-10-25
// against each provider's model docs. `local` ones (and the custom server) take a base URL and list
// whatever models the server has instead.
type ApiInfo = { id: string; name: string; baseUrl: string; key: string; models: Record<string, string>; local?: boolean }
export const APIS: ApiInfo[] = [
  {
    id: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', key: 'aistudio.google.com/apikey',
    models: {
      'gemini-3.8-flash': 'Gemini 3.8 Flash',
      'gemini-3.6-flash': 'Gemini 3.6 Flash',
      'gemini-3.5-flash-lite': 'Gemini 3.5 Flash-Lite',
      'gemini-3.1-flash-lite': 'Gemini 3.1 Flash-Lite',
      'gemini-4-argon': 'Gemini 4 Argon (paid)',
      'gemini-3.1-pro-preview': 'Gemini 3.1 Pro preview (paid)'
    }
  },
  {
    id: 'xai', name: 'xAI Grok', baseUrl: 'https://api.x.ai/v1', key: 'console.x.ai',
    models: {
      'grok-4.7': 'Grok 4.7',
      'grok-4.6': 'Grok 4.6',
      'grok-4.5': 'Grok 4.5',
      'grok-4.3': 'Grok 4.3',
      'grok-4.20-0309-reasoning': 'Grok 4.20 Reasoning',
      'grok-4.20-0309-non-reasoning': 'Grok 4.20 (no reasoning)'
    }
  },
  {
    id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', key: 'console.groq.com/keys',
    models: {
      'openai/gpt-oss-120b': 'GPT-OSS 120B',
      'openai/gpt-oss-20b': 'GPT-OSS 20B',
      'llama-3.3-70b-versatile': 'Llama 3.3 70B',
      'llama-3.1-8b-instant': 'Llama 3.1 8B Instant',
      'qwen/qwen3.8-27b': 'Qwen 3.8 27B (preview)',
      'minimaxai/minimax-m2.7': 'MiniMax M2.7 (preview)',
      'meta-models/muse-spark-open': 'Muse Spark (preview)'
    }
  },
  {
    id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', key: 'openrouter.ai/keys',
    models: {
      'openrouter/free': 'Any free model (router)',
      'google/gemma-4-31b-it:free': 'Gemma 4 31B (free)',
      'google/gemma-4-26b-a4b-it:free': 'Gemma 4 26B A4B (free)',
      'nvidia/nemotron-3-ultra-550b-a55b:free': 'Nemotron 3 Ultra (free)',
      'nvidia/nemotron-3-super-120b-a12b:free': 'Nemotron 3 Super (free)',
      'thinkingmachines/inkling:free': 'Inkling (free)',
      'thinkingmachines/inkling-small:free': 'Inkling Small (free)'
    }
  },
  {
    id: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', key: 'console.mistral.ai',
    models: {
      'mistral-small-latest': 'Mistral Small',
      'mistral-medium-latest': 'Mistral Medium',
      'mistral-large-latest': 'Mistral Large',
      'ministral-14b-latest': 'Ministral 14B',
      'ministral-8b-latest': 'Ministral 8B',
      'ministral-3b-latest': 'Ministral 3B'
    }
  },
  {
    id: 'cerebras', name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', key: 'cloud.cerebras.ai',
    models: { 'gpt-oss-120b': 'GPT-OSS 120B', 'qwen-3.8-27b': 'Qwen 3.8 27B' }
  },
  { id: 'ollama', name: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', key: '', models: {}, local: true },
  { id: 'lmstudio', name: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', key: '', models: {}, local: true },
  { id: 'openai', name: 'Other OpenAI-compatible server', baseUrl: 'http://localhost:8080/v1', key: '', models: {}, local: true }
]

// A provider's saved settings over its defaults.
const apiOf = (ai: Settings['ai'], a: ApiInfo) =>
  ({ baseUrl: a.baseUrl, model: Object.keys(a.models)[0] ?? '', apiKey: '', ...(ai.apis[a.id] as ApiConfig | undefined) })

const field = (label: string, ...control: (Node | string)[]) => h('label', { class: 'field' }, h('span', { textContent: label }), ...control)

const AI_SOURCES = { 'claude-code': 'Claude Code', ...Object.fromEntries(APIS.map((a) => [a.id, a.name])) }
const IMAGE_SOURCES = { pollinations: 'Pollinations', cloudflare: 'Cloudflare', openai: 'OpenAI-compatible' }

// `claude --model` aliases (each is the latest version) and `--effort` levels; '' is Claude Code's default.
const CLAUDE_MODELS = { '': 'Default model', fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' }
const EFFORTS = { '': 'Default effort', low: 'Low effort', medium: 'Medium effort', high: 'High effort', xhigh: 'Extra high effort', max: 'Max effort' }
const MODEL_TITLE = 'Claude model, always its latest version'
const EFFORT_TITLE = 'How hard Claude thinks: more is slower and uses more of your plan, but writes better'

// A value not in the list, like a full model id, is kept as its own option.
function setValue(sel: HTMLSelectElement, value: string) {
  if (![...sel.options].some((o) => o.value === value)) sel.append(h('option', { value, textContent: value }))
  sel.value = value
}
function select(options: Record<string, string>, value: string, title = '') {
  const sel = h('select', { title }, ...Object.entries(options).map(([value, textContent]) => h('option', { value, textContent })))
  setValue(sel, value)
  return sel
}

// Sidebar pickers for where text is generated and its model (and, with Claude Code, effort).
// Changes are saved to settings; they re-read settings on focus so the Settings dialog's changes show up.
export function textPickers(): HTMLElement[] {
  const source = select(AI_SOURCES, 'claude-code', 'Where text is generated')
  const model = select(CLAUDE_MODELS, '', MODEL_TITLE)
  const effort = select(EFFORTS, '', EFFORT_TITLE)
  const apiModel = h('select', { class: 'model', title: 'Model' })
  const current = () => APIS.find((a) => a.id === source.value)
  // Models found on local servers, kept so the list shows right away next time.
  const found: Record<string, Record<string, string>> = {}
  const fill = (options: Record<string, string>, value: string) => {
    if (Object.keys(options).join('\n') !== [...apiModel.options].map((o) => o.value).join('\n'))
      apiModel.replaceChildren(...Object.entries(options).map(([value, textContent]) => h('option', { value, textContent })))
    if (value) setValue(apiModel, value)
  }
  const sync = (s: Settings) => {
    const a = current()
    model.hidden = effort.hidden = !!a
    apiModel.hidden = !a
    if (!a) return
    const saved = apiOf(s.ai, a).model
    if (!a.local) {
      // A model dropped from the list (retired, or an old default) moves to the current default.
      fill(a.models, saved in a.models ? saved : Object.keys(a.models)[0])
      if (apiModel.value !== saved) apiModel.onchange?.(new Event('change'))
      return
    }
    fill(found[a.id] ?? {}, saved)
    api.ai.models(a.id).then((ids) => {
      if (current() !== a) return
      found[a.id] = ids.length ? Object.fromEntries(ids.map((id) => [id, id])) : { '': 'No models found. Is the server running?' }
      fill(found[a.id], saved)
      // Nothing picked yet (or it was removed from the server): use the first model it has.
      if (ids.length && !ids.includes(saved)) {
        apiModel.value = ids[0]
        apiModel.onchange?.(new Event('change'))
      }
    })
  }
  const load = async () => {
    const s = await api.settings.get()
    setValue(source, s.ai.provider)
    setValue(model, s.ai.claudeModel)
    setValue(effort, s.ai.claudeEffort)
    sync(s)
  }
  const save = async (change: (ai: Settings['ai']) => Partial<Settings['ai']>) => {
    const s = await api.settings.get()
    return api.settings.set({ ...s, ai: { ...s.ai, ...change(s.ai) } })
  }
  for (const el of [source, model, effort, apiModel]) el.onfocus = load
  // Picking an API saves its defaults too, so it works without opening Settings (local servers need no key).
  source.onchange = async () => {
    const a = current()
    sync(await save((ai) => ({ provider: source.value, apis: a ? { ...ai.apis, [a.id]: apiOf(ai, a) } : ai.apis })))
  }
  model.onchange = () => save(() => ({ claudeModel: model.value }))
  effort.onchange = () => save(() => ({ claudeEffort: effort.value }))
  apiModel.onchange = () => {
    const a = current()
    if (a) save((ai) => ({ apis: { ...ai.apis, [a.id]: { ...apiOf(ai, a), model: apiModel.value } } }))
  }
  load()
  return [source, model, effort, apiModel]
}

// Compact image provider dropdown; changing it saves the choice to settings.
export function imagePicker(): HTMLSelectElement {
  const sel = select(IMAGE_SOURCES, 'pollinations', 'Where images are generated')
  // Re-read on focus so changes made in the Settings dialog show up.
  const load = () => api.settings.get().then((s) => (sel.value = s.image.provider))
  sel.onfocus = load
  sel.onchange = async () => {
    const s = await api.settings.get()
    await api.settings.set({ ...s, image: { ...s.image, provider: sel.value as Settings['image']['provider'] } })
  }
  load()
  return sel
}

// A collapsible provider section, open when it's the one in use.
const section = (name: string, open: boolean, ...body: Node[]) =>
  h('details', { class: 'provider', open }, h('summary', { textContent: name }), h('fieldset', {}, ...body))

// Settings dialog: one section per provider with how to reach it (executable, API key, server URL).
// Which provider and model to use is picked in the AI sidebar.
export async function openSettings(): Promise<void> {
  let s: Settings = await api.settings.get()

  // A Test button that saves, then sends a tiny prompt to `provider`.
  const tester = (provider: string) => {
    const result = h('p', { class: 'hint' })
    const test = h('button', {
      textContent: 'Test',
      onclick: async () => {
        s = await api.settings.set(collect())
        result.className = 'hint'
        result.textContent = 'Testing…'
        test.disabled = true
        const r = await api.ai.test(provider)
        test.disabled = false
        result.className = 'error' in r ? 'error' : 'hint ok'
        result.textContent = 'error' in r ? r.error : `✓ ${parseReply(r.text).reply}`
      }
    })
    return h('div', { class: 'row-input' }, test, result)
  }

  const claudePath = h('input', { value: s.ai.claudePath, placeholder: 'Detecting…' })
  api.ai.detectClaude().then((p) => (claudePath.placeholder = p ? `Auto-detect: ${p}` : 'Not found — install Claude Code or enter its path'))
  const claude = section('Claude Code', s.ai.provider === 'claude-code',
    field('Executable', claudePath),
    h('p', { class: 'hint', textContent: 'Uses your Claude subscription: runs `claude -p` with no tools. Log in once by running `claude` in a terminal.' }),
    tester('claude-code')
  )

  const apis = APIS.map((a) => {
    const cfg = apiOf(s.ai, a)
    const baseUrl = h('input', { value: cfg.baseUrl, placeholder: a.baseUrl })
    const apiKey = h('input', { type: 'password', value: cfg.apiKey, placeholder: a.local ? 'Leave empty for local servers' : 'Paste your API key' })
    const el = section(a.name, s.ai.provider === a.id,
      ...(a.local ? [field('Base URL', baseUrl)] : []),
      field('API key', apiKey),
      ...(a.key ? [h('p', { class: 'hint', textContent: `Get a key at ${a.key}` })] : []),
      tester(a.id)
    )
    const value = () => ({ ...cfg, baseUrl: (a.local && baseUrl.value.trim()) || a.baseUrl, apiKey: apiKey.value.trim() })
    return { id: a.id, el, value }
  })

  const imageUrl = h('input', { value: s.image.openai.baseUrl })
  const imageModel = h('input', { value: s.image.openai.model, placeholder: "Server's default" })
  const imageKey = h('input', { type: 'password', value: s.image.openai.apiKey, placeholder: 'Leave empty for local servers' })
  const pollinations = section('Pollinations', s.image.provider === 'pollinations',
    h('p', { class: 'hint', textContent: 'Free, with no key or setup. Images get a small watermark.' })
  )
  const cfAccount = h('input', { value: s.image.cloudflare.accountId, placeholder: '32-character ID' })
  const cfToken = h('input', { type: 'password', value: s.image.cloudflare.apiToken, placeholder: 'Paste your API token' })
  const cloudflare = section('Cloudflare Workers AI', s.image.provider === 'cloudflare',
    field('Account ID', cfAccount),
    field('API token', cfToken),
    h('p', { class: 'hint', textContent: 'Free for about 95 images a day (FLUX.2 klein), no watermark. Sign up at dash.cloudflare.com, then under AI → Workers AI copy the account ID and create a "Workers AI" API token.' })
  )
  const imageOpenai = section('OpenAI-compatible image server', s.image.provider === 'openai',
    field('Base URL', imageUrl),
    field('Model', imageModel),
    field('API key', imageKey),
    h('p', { class: 'hint', textContent: 'Calls POST <base URL>/images/generations, e.g. `sd-server --listen-port 8080` from stable-diffusion.cpp.' })
  )

  const collect = (): Settings => ({
    ...s,
    ai: {
      ...s.ai,
      claudePath: claudePath.value.trim(),
      apis: { ...s.ai.apis, ...Object.fromEntries(apis.map((x) => [x.id, x.value()])) }
    },
    image: {
      ...s.image,
      openai: { baseUrl: imageUrl.value.trim(), model: imageModel.value.trim(), apiKey: imageKey.value.trim() },
      cloudflare: { accountId: cfAccount.value.trim(), apiToken: cfToken.value.trim() }
    }
  })

  // A sidebar of pages; clicking one shows it in place of the others.
  const pages: [string, Node[]][] = [
    ['AI Writing', [claude, ...apis.map((x) => x.el)]],
    ['AI Images', [pollinations, cloudflare, imageOpenai]]
  ]
  const hint = h('p', { class: 'hint', textContent: 'Choose which provider and model to use in the AI sidebar.' })
  const views = pages.map(([, body]) => h('div', { class: 'settings-page' }, hint.cloneNode(true), ...body))
  const tabs = pages.map(([name], i) => h('button', { textContent: name, onclick: () => show(i) }))
  const show = (i: number) => {
    views.forEach((v, j) => (v.hidden = j !== i))
    tabs.forEach((t, j) => t.classList.toggle('on', j === i))
  }
  show(0)

  const dlg = modal(
    'Settings',
    [h('div', { class: 'settings-layout' }, h('nav', {}, ...tabs), ...views)],
    [
      h('button', { textContent: 'Cancel', onclick: () => dlg.close() }),
      h('button', { class: 'primary', textContent: 'Save', onclick: async () => (await api.settings.set(collect()), dlg.close()) })
    ]
  )
  dlg.box.classList.add('settings')
}
