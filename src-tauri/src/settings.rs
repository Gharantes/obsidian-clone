use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

// Same shape as the renderer's `Settings` type; missing fields take their defaults.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    // Where new books are created; defaults to Documents/Books.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub library: Option<String>,
    pub ai: Ai,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct Ai {
    // "claude-code" or "openai".
    pub provider: String,
    // Claude Code executable; empty means auto-detect.
    pub claude_path: String,
    // Model alias or full id passed to `claude --model`; empty uses Claude Code's default.
    pub claude_model: String,
    // Any OpenAI-compatible /chat/completions endpoint (Ollama, Groq, OpenRouter, Gemini, ...).
    pub openai: OpenAi,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct OpenAi {
    pub base_url: String,
    pub model: String,
    pub api_key: String,
}

impl Default for Ai {
    fn default() -> Self {
        Ai { provider: "claude-code".into(), claude_path: String::new(), claude_model: "sonnet".into(), openai: OpenAi::default() }
    }
}

impl Default for OpenAi {
    fn default() -> Self {
        OpenAi { base_url: "http://localhost:11434/v1".into(), model: "llama3.2".into(), api_key: String::new() }
    }
}

// Reads settings over the defaults; a missing or broken file means defaults.
pub fn load_settings(file: &Path) -> Settings {
    fs::read_to_string(file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn save_settings(file: &Path, s: &Settings) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(file, serde_json::to_string_pretty(s)?)
}
