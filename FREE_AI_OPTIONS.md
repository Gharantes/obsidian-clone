# Free ways to generate text

The notes for possible free AI backends. Researched **2026-10-20**. Free tiers change often, so
check the provider's own limits page before relying on any number here.

## How the app plugs into these

The app has two AI providers (Settings → AI writing):

1. **Claude Code**: the default. It runs `claude -p` headless with no tools, so it uses your
   Claude subscription and needs no API key. It's not free, but it costs nothing extra if you
   already pay for Claude. It's implemented in `src/main/ai.ts` (`claudeCode`).
2. **OpenAI-compatible API**: any server with a `/chat/completions` endpoint. Almost every
   option below speaks this protocol, so trying one is just: pick the preset (or type the base
   URL), set the model, paste a key, press **Test**. It's implemented in `src/main/ai.ts`
   (`openaiCompatible`); the presets are in `src/renderer/settings.ts`.

Anything that is *not* OpenAI-compatible would need a new provider function next to those two.

## Best bets

| Option | Why | Preset in app |
|---|---|---|
| **Ollama** (local) | Free forever, private, offline, no account. Needs a decent machine (8 GB+ RAM for small models, a GPU helps). | ✅ Ollama (local) |
| **Google Gemini** (AI Studio key) | Strong Flash models, big context, no card. | ✅ Google Gemini |
| **Groq** | Very fast, about 1,000 requests a day, no card. | ✅ Groq |
| **OpenRouter `:free` models** | One key, many free models, and the `openrouter/free` router picks one. | ✅ OpenRouter |

## Local (free, unlimited, private)

| Tool | Base URL | Notes |
|---|---|---|
| [Ollama](https://ollama.com) | `http://localhost:11434/v1` | `ollama pull llama3.2` (or `gemma3`, `qwen3`, `mistral`…), then set that name as the model. No key. |
| [LM Studio](https://lmstudio.ai) | `http://localhost:1234/v1` | GUI to download models; start its local server. Model = the id shown in LM Studio. |
| llama.cpp `llama-server` | `http://localhost:8080/v1` | Lightest option; serves one GGUF model. |
| [Jan](https://jan.ai) | `http://localhost:1337/v1` | GUI app with an OpenAI-compatible local server. |

For writing prose, models around 7–14B parameters give good quality on a normal PC. 3B models
are fast but weaker.

## Hosted free tiers (OpenAI-compatible)

| Provider | Base URL | Example model | Free limits (approx.) | Card? | Caveats |
|---|---|---|---|---|---|
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-3.8-flash` | Flash models only; roughly 5–15 RPM, caps shown in AI Studio | No | Outside EU/UK/EEA, free-tier prompts may be used to improve Google products |
| Groq | `https://api.groq.com/openai/v1` | `openai/gpt-oss-120b`, `qwen/qwen3.8-27b` | ~30 RPM, ~1,000 req/day, daily token cap | No | Limits vary per model |
| OpenRouter | `https://openrouter.ai/api/v1` | `openrouter/free`, or any `…:free` model | 20 RPM; 50 req/day (1,000/day after buying $10 of credits once) | No | Free model list changes often |
| Cerebras | `https://api.cerebras.ai/v1` | `gpt-oss-120b` | Free trial tier, ~1M tokens/day reported | Reports differ | Sources disagree on whether it's permanent |
| Mistral | `https://api.mistral.ai/v1` | `mistral-small-latest` | "Experiment" tier, generous monthly tokens | No | Experiment tier requires opting into training on your data |
| GitHub Models | `https://models.github.ai/inference` | `openai/gpt-4.1-mini` (check catalog) | ~15 RPM, 150–1,000 req/day | No | Needs a GitHub token with `models:read`; small context limits |
| Cloudflare Workers AI | `https://api.cloudflare.com/client/v4/accounts/<ID>/ai/v1` | Llama / Mistral models | ~10K "neurons"/day | No | Needs account ID in the URL |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | Llama / Nemotron | ~1,000 req/day reported | No | Developer program signup |
| Hugging Face Inference Providers | `https://router.huggingface.co/v1` | many open models | Small monthly free credit | No | Credits run out quickly |

## Trial credits (free to start, not forever)

DeepSeek (token grant), SambaNova ($5, card at signup), Fireworks ($1), Nebius ($1), AI21 ($10),
Baseten ($30). These are fine for trying a model, not for ongoing free use.

## Not usable here (or not free)

- **Cohere free key**: non-commercial only, and only partly OpenAI-compatible.
- **ChatGPT / Claude.ai / Gemini web apps**: free in the browser, but have no API to call from
  an app.

## Images (covers and pictures in notes)

Settings → Images. Checked **2026-10-20**.

| Option | Cost | Notes |
|---|---|---|
| **Pollinations** (default) | Free, no key, no account | `image.pollinations.ai/prompt/…`. 1 image every 45 s per IP, small "pollinations.ai" watermark. Pollinations calls this endpoint "legacy", so it may go away. Keyed use (`gen.pollinations.ai`) spends "pollen" credits, so it's not in the app. |
| **stable-diffusion.cpp** `sd-server` (local) | Free, unlimited, offline | Pick *OpenAI-compatible server*, base URL `http://127.0.0.1:8080/v1`. Needs a model file (e.g. SD 1.5/SDXL/FLUX schnell GGUF) and a decent GPU or patience. |
| **LocalAI** (local) | Free | Same OpenAI `/v1/images/generations` API. |

Not usable for free: Ollama's image generation is macOS-only (and experimental). Gemini/Imagen image
models have no reliable free API tier. Cloudflare Workers AI has free FLUX (10K neurons/day), but
it isn't OpenAI-compatible for images, so it would need its own provider.

## Ideas for later

- Add a model dropdown filled from `GET {baseUrl}/models` (works on Ollama, OpenRouter, Groq…).
- Fallback chain: if the main provider errors (rate limit), retry with the next configured one.
- Show a "free requests left today" hint for providers that return rate-limit headers.

## Sources

- [Pollinations API docs](https://github.com/pollinations/pollinations/blob/main/APIDOCS.md), [stable-diffusion.cpp server](https://github.com/leejet/stable-diffusion.cpp/tree/master/examples/server), [Ollama image generation](https://github.com/ollama/ollama/blob/main/x/imagegen/README.md)

- [OpenRouter: Free LLM APIs in 2026, 13 options compared](https://openrouter.ai/blog/tutorials/free-llm-apis-compared/) (updated 2026-09-24)
- [Gemini API OpenAI compatibility docs](https://ai.google.dev/gemini-api/docs/openai)
- [Groq rate limits](https://console.groq.com/docs/rate-limits)
- [Cerebras models overview](https://inference-docs.cerebras.ai/models/overview)
- [BenchLM: OpenRouter free models](https://benchlm.ai/md/free-tier/openrouter.md), [TrueFoundry on OpenRouter limits](https://www.truefoundry.com/es/blog/openrouter-rate-limits-your-free-tier-depends-on-what-youve-already-paid)
- [Free LLM API: real limits and catches (continuumcode.ai)](https://continuumcode.ai/guides/free-llm-api/), [KDnuggets: 5 free LLM API providers](https://www.kdnuggets.com/5-free-llm-api-providers-you-can-use-in-2026)
- [Free-LLM directory (GitHub)](https://github.com/nejib1/Free-LLM)
