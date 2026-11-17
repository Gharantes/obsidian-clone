use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

// Same shape as the renderer's `Settings` type; missing fields take their defaults.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub ai: Ai,
    pub image: Image,
    pub pixiv: Pixiv,
    pub reddit: Reddit,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Reddit {
    // The reddit_session cookie (or a whole Cookie header) of a logged-in Reddit account; Reddit
    // blocks logged-out downloads.
    pub session: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Pixiv {
    // The PHPSESSID cookie of a logged-in pixiv account, for R-18 works; empty downloads public works only.
    pub session: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct Ai {
    // "claude-code" or a key of `apis`.
    pub provider: String,
    // Claude Code executable; empty means auto-detect.
    pub claude_path: String,
    // Model alias or full id passed to `claude --model`; empty uses Claude Code's default.
    pub claude_model: String,
    // `claude --effort`: low, medium, high, xhigh or max; empty uses Claude Code's default.
    pub claude_effort: String,
    // OpenAI-compatible /chat/completions APIs by provider id (gemini, groq, ollama, ...);
    // "openai" is a custom server. The renderer fills in each one's base URL.
    pub apis: BTreeMap<String, OpenAi>,
    // The single API of older settings; moved to apis["openai"] on load.
    #[serde(skip_serializing)]
    pub openai: Option<OpenAi>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct OpenAi {
    pub base_url: String,
    pub model: String,
    pub api_key: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct Image {
    // "pollinations" (free, no key), "cloudflare" or "openai".
    pub provider: String,
    // Any OpenAI-compatible /images/generations endpoint (stable-diffusion.cpp, LocalAI, ...).
    pub openai: OpenAi,
    // Workers AI, free up to a daily allowance.
    pub cloudflare: Cloudflare,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Cloudflare {
    pub account_id: String,
    pub api_token: String,
}

impl Default for Image {
    fn default() -> Self {
        Image { provider: "pollinations".into(), openai: OpenAi { base_url: "http://127.0.0.1:8080/v1".into(), model: String::new(), api_key: String::new() }, cloudflare: Cloudflare::default() }
    }
}

impl Default for Ai {
    fn default() -> Self {
        Ai { provider: "claude-code".into(), claude_path: String::new(), claude_model: "sonnet".into(), claude_effort: String::new(), apis: BTreeMap::new(), openai: None }
    }
}

// Reads settings over the defaults; a missing or broken file means defaults.
pub fn load_settings(file: &Path) -> Settings {
    let mut s: Settings = fs::read_to_string(file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    if let Some(old) = s.ai.openai.take() {
        s.ai.apis.entry("openai".into()).or_insert(old);
    }
    s
}

pub fn save_settings(file: &Path, s: &Settings) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(file, serde_json::to_string_pretty(s)?)
}
