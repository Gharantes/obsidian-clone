use crate::settings::{Ai, OpenAi};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;

const WIN: bool = cfg!(windows);
const EXE: &str = if WIN { "claude.exe" } else { "claude" };
// Keeps child processes from flashing a console window on Windows.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn command(program: impl AsRef<std::ffi::OsStr>) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

// Newest "x.y.z" first.
fn by_version_desc(a: &String, b: &String) -> std::cmp::Ordering {
    crate::files::natural_cmp(b, a)
}

// Claude Code executables worth trying, most likely first: PATH, the native installer, then
// the binary bundled with the VS Code (and fork) extension.
async fn candidates(home: &Path) -> Vec<PathBuf> {
    let found = if WIN { command("where.exe").arg("claude").output().await } else { command("which").args(["-a", "claude"]).output().await };
    let on_path: Vec<String> = found
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).lines().filter(|l| !l.is_empty()).map(String::from).collect())
        .unwrap_or_default();
    // `where` lists the extensionless npm shim too; only .exe/.cmd can be started on Windows.
    let mut paths: Vec<PathBuf> = if WIN {
        let has = |p: &String, ext: &str| p.to_lowercase().ends_with(ext);
        let exes = on_path.iter().filter(|p| has(p, ".exe"));
        let cmds = on_path.iter().filter(|p| has(p, ".cmd"));
        exes.chain(cmds).map(PathBuf::from).collect()
    } else {
        on_path.into_iter().map(PathBuf::from).collect()
    };
    paths.push(home.join(".local").join("bin").join(EXE));
    paths.push(home.join(".claude").join("local").join(EXE));
    if !WIN {
        paths.extend(["/opt/homebrew/bin/claude", "/usr/local/bin/claude"].map(PathBuf::from));
    }
    for editor in [".vscode", ".vscode-insiders", ".cursor", ".windsurf"] {
        let dir = home.join(editor).join("extensions");
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .map(|it| it.flatten().map(|d| d.file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with("anthropic.claude-code-")).collect())
            .unwrap_or_default();
        names.sort_by(by_version_desc);
        paths.extend(names.iter().map(|n| dir.join(n).join("resources").join("native-binary").join(EXE)));
    }
    paths
}

// The configured Claude Code executable if it exists, else the first one found.
pub async fn find_claude(configured: &str, home: &Path) -> Option<PathBuf> {
    if !configured.is_empty() {
        let p = PathBuf::from(configured);
        return p.exists().then_some(p);
    }
    candidates(home).await.into_iter().find(|p| p.exists())
}

#[derive(Debug, PartialEq, Default)]
pub struct ClaudeEvent {
    pub text: Option<String>,
    pub fin: Option<String>,
    pub error: Option<String>,
}

// Reads one line of `claude --output-format stream-json --include-partial-messages`.
pub fn parse_claude_line(line: &str) -> ClaudeEvent {
    let Ok(ev) = serde_json::from_str::<Value>(line) else { return ClaudeEvent::default() };
    let s = |v: &Value| v.as_str().map(String::from);
    if ev["type"] == "stream_event" && ev["event"]["type"] == "content_block_delta" && ev["event"]["delta"]["type"] == "text_delta" {
        return ClaudeEvent { text: s(&ev["event"]["delta"]["text"]), ..Default::default() };
    }
    if ev["type"] == "result" {
        if ev["is_error"] == true || ev["subtype"] != "success" {
            let errors = ev["errors"].as_array().map(|a| a.iter().filter_map(|e| e.as_str()).collect::<Vec<_>>().join("\n"));
            let msg = [s(&ev["result"]), errors, s(&ev["subtype"])].into_iter().flatten().find(|m| !m.is_empty());
            return ClaudeEvent { error: Some(msg.unwrap_or_else(|| "Claude Code failed".into())), ..Default::default() };
        }
        return ClaudeEvent { fin: Some(s(&ev["result"]).unwrap_or_default()), ..Default::default() };
    }
    ClaudeEvent::default()
}

// Runs Claude Code headless with no tools, feeding the prompt on stdin and streaming the reply.
async fn claude_code(path: &Path, model: &str, workdir: &Path, prompt: &str, system: &str, on_text: &mut (dyn FnMut(&str) + Send), cancel: &CancellationToken) -> Result<(), String> {
    std::fs::create_dir_all(workdir).map_err(|e| e.to_string())?;
    let mut cmd = command(path);
    cmd.args(["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--system-prompt", system]);
    if !model.is_empty() {
        cmd.args(["--model", model]);
    }
    cmd.current_dir(workdir).env_remove("CLAUDECODE").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("Could not start Claude Code ({}): {e}", path.display()))?;

    let mut stdin = child.stdin.take().unwrap();
    let prompt = prompt.to_string();
    // The process may exit before reading everything; ignore write errors.
    tokio::spawn(async move {
        let _ = stdin.write_all(prompt.as_bytes()).await;
    });
    let mut stderr = child.stderr.take().unwrap();
    let stderr = tokio::spawn(async move {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s).await;
        s
    });

    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let (mut streamed, mut error) = (false, None);
    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                // Kill the whole tree: a .cmd shim runs claude under cmd.exe.
                match child.id() {
                    Some(pid) if WIN => { let _ = command("taskkill").args(["/pid", &pid.to_string(), "/T", "/F"]).status().await; }
                    _ => { let _ = child.kill().await; }
                }
                return Ok(());
            }
            line = lines.next_line() => match line {
                Ok(Some(line)) => {
                    let ev = parse_claude_line(&line);
                    if let Some(t) = ev.text {
                        streamed = true;
                        on_text(&t);
                    }
                    if let Some(f) = ev.fin.filter(|_| !streamed) {
                        on_text(&f); // CLI without partial messages
                    }
                    if ev.error.is_some() {
                        error = ev.error;
                    }
                }
                _ => break,
            }
        }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let stderr = stderr.await.unwrap_or_default();
    if let Some(e) = error {
        return Err(e);
    }
    if !status.success() {
        let code = status.code().map_or("a signal".to_string(), |c| format!("code {c}"));
        return Err(if stderr.trim().is_empty() { format!("Claude Code exited with {code}") } else { stderr.trim().to_string() });
    }
    Ok(())
}

// Splits a Server-Sent Events stream into `data:` payloads; feed it chunks, it calls on_data.
#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
}

impl SseParser {
    pub fn feed(&mut self, chunk: &[u8], mut on_data: impl FnMut(&str) -> Result<(), String>) -> Result<(), String> {
        self.buf.extend_from_slice(chunk);
        while let Some(i) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=i).collect();
            let line = String::from_utf8_lossy(&line);
            if let Some(data) = line.trim_end_matches(['\r', '\n']).strip_prefix("data:") {
                on_data(data.trim())?;
            }
        }
        Ok(())
    }
}

// Streams from any OpenAI-compatible /chat/completions endpoint.
async fn openai_compatible(cfg: &OpenAi, prompt: &str, system: &str, on_text: &mut (dyn FnMut(&str) + Send), cancel: &CancellationToken) -> Result<(), String> {
    let mut req = reqwest::Client::new()
        .post(format!("{}/chat/completions", cfg.base_url.trim_end_matches('/')))
        .header("content-type", "application/json")
        .body(json!({ "model": cfg.model, "stream": true, "messages": [{ "role": "system", "content": system }, { "role": "user", "content": prompt }] }).to_string());
    if !cfg.api_key.is_empty() {
        req = req.bearer_auth(&cfg.api_key);
    }
    let res = tokio::select! {
        _ = cancel.cancelled() => return Ok(()),
        r = req.send() => r.map_err(|e| {
            let why = std::error::Error::source(&e).map_or(e.to_string(), |s| s.to_string());
            format!("Could not reach {} ({why}). Is the server running and the URL right?", cfg.base_url)
        })?,
    };
    if !res.status().is_success() {
        let status = res.status();
        let body: String = res.text().await.unwrap_or_default().chars().take(500).collect();
        return Err(format!("{status}: {body}"));
    }

    let mut parser = SseParser::default();
    let mut stream = res.bytes_stream();
    loop {
        let chunk = tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            c = stream.next() => match c {
                None => return Ok(()),
                Some(c) => c.map_err(|e| e.to_string())?,
            },
        };
        parser.feed(&chunk, |data| {
            if data == "[DONE]" {
                return Ok(());
            }
            let Ok(json) = serde_json::from_str::<Value>(data) else { return Ok(()) };
            if !json["error"].is_null() {
                return Err(json["error"]["message"].as_str().map_or(json["error"].to_string(), String::from));
            }
            if let Some(t) = json["choices"][0]["delta"]["content"].as_str().filter(|t| !t.is_empty()) {
                on_text(t);
            }
            Ok(())
        })?;
    }
}

// Generates with the configured provider, calling on_text for each piece of the reply.
pub async fn generate(ai: &Ai, home: &Path, workdir: &Path, prompt: &str, system: &str, on_text: &mut (dyn FnMut(&str) + Send), cancel: &CancellationToken) -> Result<(), String> {
    if ai.provider == "openai" {
        return openai_compatible(&ai.openai, prompt, system, on_text, cancel).await;
    }
    let Some(path) = find_claude(&ai.claude_path, home).await else {
        return Err(if ai.claude_path.is_empty() {
            "Claude Code not found. Install it (npm i -g @anthropic-ai/claude-code), then run `claude` once to log in, or set its path in Settings.".into()
        } else {
            format!("Claude Code not found at {}", ai.claude_path)
        });
    };
    claude_code(&path, &ai.claude_model, workdir, prompt, system, on_text, cancel).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_code_stream_json_lines() {
        let delta = json!({ "type": "stream_event", "event": { "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "Hi" } } });
        assert_eq!(parse_claude_line(&delta.to_string()).text.as_deref(), Some("Hi"));
        let ok = json!({ "type": "result", "subtype": "success", "is_error": false, "result": "Hi there" });
        assert_eq!(parse_claude_line(&ok.to_string()).fin.as_deref(), Some("Hi there"));
        let err = json!({ "type": "result", "subtype": "success", "is_error": true, "result": "Please run /login" });
        assert_eq!(parse_claude_line(&err.to_string()).error.as_deref(), Some("Please run /login"));
        assert_eq!(parse_claude_line(r#"{"type":"system","subtype":"init"}"#), ClaudeEvent::default());
        assert_eq!(parse_claude_line("not json"), ClaudeEvent::default());
    }

    #[test]
    fn server_sent_events_split_across_chunks() {
        let mut got = Vec::new();
        let mut parser = SseParser::default();
        for chunk in ["data: {\"a\":1}\n\nda", "ta: {\"b\":2}\r\n", ": comment\ndata: [DONE]\n"] {
            parser.feed(chunk.as_bytes(), |d| Ok(got.push(d.to_string()))).unwrap();
        }
        assert_eq!(got, [r#"{"a":1}"#, r#"{"b":2}"#, "[DONE]"]);
    }
}
