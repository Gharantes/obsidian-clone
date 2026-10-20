// Hides the console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod books;
mod files;
mod settings;
mod vaults;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};
use settings::Settings;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio_util::sync::CancellationToken;
use vaults::Registry;

// Every window shows the library (vault None) or one book.
struct Win {
    vault: Option<String>,
    _watcher: Option<RecommendedWatcher>,
}

struct App {
    // Electron's userData folder, so existing books and settings carry over.
    dir: PathBuf,
    documents: PathBuf,
    home: PathBuf,
    vaults: Registry,
    settings: Settings,
    windows: HashMap<String, Win>,
    next_window: u32,
    jobs: HashMap<String, CancellationToken>,
    quitting: bool,
}

type AppState<'a> = State<'a, Mutex<App>>;

impl App {
    fn save(&self) {
        let _ = vaults::save_registry(&self.dir.join("vaults.json"), &self.vaults);
    }

    fn library(&self) -> PathBuf {
        self.settings.library.as_ref().filter(|l| !l.is_empty()).map_or_else(|| self.documents.join("Books"), PathBuf::from)
    }

    fn window_with(&self, id: &str) -> Option<String> {
        self.windows.iter().find(|(_, w)| w.vault.as_deref() == Some(id)).map(|(l, _)| l.clone())
    }

    fn vault_path(&self, id: &str) -> Result<PathBuf, String> {
        self.vaults.get(id).map(|v| v.path.clone()).ok_or_else(|| "Book not found".to_string())
    }

    // Folder of the book shown in a window.
    fn vault_of(&self, label: &str) -> Result<PathBuf, String> {
        let id = self.windows.get(label).and_then(|w| w.vault.clone()).ok_or("Window has no book")?;
        self.vault_path(&id)
    }

    // Points a window at a book (or back at the library) and watches the book folder.
    fn attach(&mut self, app: &AppHandle, label: &str, id: Option<String>) {
        let old = self.windows.get(label).and_then(|w| w.vault.clone());
        if let Some(old) = old.filter(|o| Some(o) != id.as_ref()) {
            self.vaults.get_mut(&old).map(|v| v.open = false);
        }
        let watcher = id.as_ref().and_then(|id| {
            let v = self.vaults.get_mut(id)?;
            v.open = true;
            watch(app, label, &v.path)
        });
        self.windows.insert(label.to_string(), Win { vault: id, _watcher: watcher });
        self.save();
    }
}

// Tells the window when anything in the book changes on disk (debounced); stops when dropped.
fn watch(app: &AppHandle, label: &str, path: &Path) -> Option<RecommendedWatcher> {
    let (tx, rx) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |_| {
        let _ = tx.send(());
    })
    .ok()?;
    watcher.watch(path, RecursiveMode::Recursive).ok()?;
    let (app, label) = (app.clone(), label.to_string());
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            loop {
                match rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(()) => continue,
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            let _ = app.emit_to(label.as_str(), "fs-changed", ());
        }
    });
    Some(watcher)
}

fn create_window(app: &AppHandle, vault: Option<String>) -> Result<(), String> {
    let label = {
        let state = app.state::<Mutex<App>>();
        let mut st = state.lock().unwrap();
        st.next_window += 1;
        let label = format!("w{}", st.next_window);
        st.windows.insert(label.clone(), Win { vault: None, _watcher: None });
        if vault.is_some() {
            st.attach(app, &label, vault);
        }
        label
    };
    // Built without holding the lock: window events lock it on the main thread.
    WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("Obsidian Clone")
        .inner_size(1200.0, 800.0)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn reload(window: &WebviewWindow) {
    let _ = window.eval("location.reload()");
}

// Opens a folder as a book in the calling window (or focuses the window that has it).
fn open_book(app: &AppHandle, window: &WebviewWindow, path: &Path, new_window: bool) -> Option<String> {
    let other = {
        let state = app.state::<Mutex<App>>();
        let mut st = state.lock().unwrap();
        let id = match vaults::add_vault(&mut st.vaults, path) {
            Ok(id) => id,
            Err(e) => return Some(e),
        };
        st.save();
        let other = st.window_with(&id);
        match &other {
            None if !new_window => st.attach(app, window.label(), Some(id)),
            None => {
                drop(st);
                return create_window(app, Some(id)).err();
            }
            Some(_) => {}
        }
        other
    };
    match other.and_then(|l| app.get_webview_window(&l)) {
        Some(w) => {
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
        None => reload(window),
    }
    None
}

fn pick_folder(window: &WebviewWindow, start: Option<PathBuf>) -> Option<PathBuf> {
    let mut dialog = window.dialog().file().set_parent(window);
    if let Some(dir) = start {
        dialog = dialog.set_directory(dir);
    }
    dialog.blocking_pick_folder()?.into_path().ok()
}

fn moved(r: Result<String, String>) -> Value {
    match r {
        Ok(path) => json!({ "path": path }),
        Err(error) => json!({ "error": error }),
    }
}

fn title_of(path: &Path) -> String {
    path.file_name().map_or_else(|| path.to_string_lossy().into_owned(), |n| n.to_string_lossy().into_owned())
}

// --- Books (library page) ---

#[tauri::command]
fn book_list(state: AppState) -> Vec<Value> {
    let st = state.lock().unwrap();
    let mut books: Vec<(u64, Value)> = st
        .vaults
        .iter()
        .map(|(id, v)| {
            let missing = !v.path.is_dir();
            let mut book = json!({ "id": id, "path": v.path, "ts": v.ts, "title": title_of(&v.path), "missing": missing, "notes": if missing { 0 } else { books::count_notes(&v.path) } });
            book.as_object_mut().unwrap().extend(books::read_meta(&v.path));
            (v.ts, book)
        })
        .collect();
    books.sort_by(|a, b| b.0.cmp(&a.0));
    books.into_iter().map(|(_, b)| b).collect()
}

#[tauri::command]
fn book_covers() -> Vec<&'static str> {
    books::COVERS.to_vec()
}

#[tauri::command]
async fn book_create(app: AppHandle, window: WebviewWindow, title: String, color: String) -> Option<String> {
    let library = app.state::<Mutex<App>>().lock().unwrap().library();
    match books::create_book(&library, &title, Some(&color)) {
        Ok(path) => open_book(&app, &window, &path, false),
        Err(e) => Some(e),
    }
}

#[tauri::command]
async fn book_open(app: AppHandle, window: WebviewWindow, id: String, new_window: Option<bool>) -> Option<String> {
    let path = app.state::<Mutex<App>>().lock().unwrap().vault_path(&id);
    match path {
        Ok(path) => open_book(&app, &window, &path, new_window.unwrap_or(false)),
        Err(e) => Some(e),
    }
}

#[tauri::command]
async fn book_pick(app: AppHandle, window: WebviewWindow) -> Option<String> {
    let path = pick_folder(&window, None)?;
    open_book(&app, &window, &path, false)
}

#[tauri::command]
async fn book_close(app: AppHandle, window: WebviewWindow) {
    app.state::<Mutex<App>>().lock().unwrap().attach(&app, window.label(), None);
    reload(&window);
}

#[tauri::command]
fn book_current(state: AppState, window: WebviewWindow) -> Option<Value> {
    let st = state.lock().unwrap();
    let id = st.windows.get(window.label())?.vault.clone()?;
    let path = &st.vaults.get(&id)?.path;
    Some(json!({ "id": id, "path": path, "title": title_of(path) }))
}

#[tauri::command]
fn book_rename(state: AppState, id: String, title: String) -> Option<String> {
    let mut st = state.lock().unwrap();
    if st.window_with(&id).is_some() {
        return Some("Close the book before renaming it".into());
    }
    let path = match st.vault_path(&id) {
        Ok(p) => p,
        Err(e) => return Some(e),
    };
    let parent = path.parent().unwrap_or(&path).to_path_buf();
    if let Err(e) = files::rename_entry(&parent, &title_of(&path), &title) {
        return Some(e);
    }
    st.vaults.get_mut(&id).unwrap().path = parent.join(title.trim());
    st.save();
    None
}

#[tauri::command]
fn book_color(state: AppState, id: String, color: String) -> Result<(), String> {
    let path = state.lock().unwrap().vault_path(&id)?;
    let mut meta = books::read_meta(&path);
    meta.insert("color".into(), color.into());
    books::write_meta(&path, &meta).map_err(|e| e.to_string())
}

#[tauri::command]
fn book_reveal(app: AppHandle, state: AppState, id: String) -> Result<(), String> {
    let path = state.lock().unwrap().vault_path(&id)?;
    app.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

// Forgets a book; with `trash` also moves its folder to the OS trash.
#[tauri::command]
async fn book_remove(app: AppHandle, id: String, trash: bool) -> Option<String> {
    let state = app.state::<Mutex<App>>();
    let mut st = state.lock().unwrap();
    if st.window_with(&id).is_some() {
        return Some("Close the book first".into());
    }
    let path = st.vault_path(&id).ok()?;
    if trash && path.exists() && ::trash::delete(&path).is_err() {
        return Some("Couldn't move the folder to the trash".into());
    }
    st.vaults.remove(&id);
    st.save();
    None
}

// --- Files inside the window's book ---

fn vault_of(state: &AppState, window: &WebviewWindow) -> Result<PathBuf, String> {
    state.lock().unwrap().vault_of(window.label())
}

#[tauri::command]
fn fs_list(state: AppState, window: WebviewWindow) -> Result<Vec<files::Entry>, String> {
    files::list_tree(&vault_of(&state, &window)?, "").map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_read(state: AppState, window: WebviewWindow, path: String) -> Result<String, String> {
    std::fs::read_to_string(files::in_vault(&vault_of(&state, &window)?, &path)?).map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_write(state: AppState, window: WebviewWindow, path: String, text: String) -> Result<(), String> {
    std::fs::write(files::in_vault(&vault_of(&state, &window)?, &path)?, text).map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_rename(state: AppState, window: WebviewWindow, path: String, name: String) -> Result<Value, String> {
    Ok(moved(files::rename_entry(&vault_of(&state, &window)?, &path, &name)))
}

#[tauri::command]
fn fs_nest(state: AppState, window: WebviewWindow, path: String) -> Result<Value, String> {
    Ok(moved(files::nest_note(&vault_of(&state, &window)?, &path)))
}

#[tauri::command]
fn fs_move(state: AppState, window: WebviewWindow, path: String, dest: String) -> Result<Value, String> {
    Ok(moved(files::move_entry(&vault_of(&state, &window)?, &path, &dest)))
}

// Moves to the OS trash; false when the filesystem has none (e.g. tmpfs).
#[tauri::command]
async fn fs_trash(app: AppHandle, window: WebviewWindow, path: String) -> Result<bool, String> {
    let root = app.state::<Mutex<App>>().lock().unwrap().vault_of(window.label())?;
    Ok(::trash::delete(files::in_vault(&root, &path)?).is_ok())
}

#[tauri::command]
fn fs_remove(state: AppState, window: WebviewWindow, path: String) -> Result<(), String> {
    let full = files::in_vault(&vault_of(&state, &window)?, &path)?;
    if full.is_dir() { std::fs::remove_dir_all(full) } else { std::fs::remove_file(full) }.map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_create(state: AppState, window: WebviewWindow, folder: bool, parent: Option<String>) -> Result<String, String> {
    files::create_entry(&vault_of(&state, &window)?, parent.as_deref().unwrap_or(""), folder)
}

// --- Settings ---

const MASK: &str = "••••••••";

// The renderer never sees the stored API key, only whether there is one.
fn public_settings(st: &App) -> Settings {
    let mut s = st.settings.clone();
    s.library = Some(st.library().to_string_lossy().into_owned());
    if !s.ai.openai.api_key.is_empty() {
        s.ai.openai.api_key = MASK.into();
    }
    s
}

#[tauri::command]
fn settings_get(state: AppState) -> Settings {
    public_settings(&state.lock().unwrap())
}

#[tauri::command]
fn settings_set(state: AppState, s: Settings) -> Settings {
    let mut st = state.lock().unwrap();
    let mut s = s;
    if s.ai.openai.api_key == MASK {
        s.ai.openai.api_key = st.settings.ai.openai.api_key.clone();
    }
    st.settings = s;
    let _ = settings::save_settings(&st.dir.join("settings.json"), &st.settings);
    public_settings(&st)
}

#[tauri::command]
async fn settings_pick_library(app: AppHandle, window: WebviewWindow) -> Option<String> {
    let library = app.state::<Mutex<App>>().lock().unwrap().library();
    pick_folder(&window, Some(library)).map(|p| p.to_string_lossy().into_owned())
}

// --- AI ---

// Streams generated text to the calling window as ai-chunk events; resolves to an error message or null.
#[tauri::command]
async fn ai_generate(app: AppHandle, window: WebviewWindow, id: String, prompt: String, system: String) -> Option<String> {
    let cancel = CancellationToken::new();
    let (ai, home, workdir) = {
        let state = app.state::<Mutex<App>>();
        let mut st = state.lock().unwrap();
        st.jobs.insert(id.clone(), cancel.clone());
        (st.settings.ai.clone(), st.home.clone(), st.dir.join("ai-workdir"))
    };
    let label = window.label().to_string();
    let mut on_text = |t: &str| {
        let _ = app.emit_to(label.as_str(), "ai-chunk", (&id, t));
    };
    let r = ai::generate(&ai, &home, &workdir, &prompt, &system, &mut on_text, &cancel).await;
    app.state::<Mutex<App>>().lock().unwrap().jobs.remove(&id);
    r.err()
}

#[tauri::command]
fn ai_cancel(state: AppState, id: String) {
    if let Some(job) = state.lock().unwrap().jobs.get(&id) {
        job.cancel();
    }
}

#[tauri::command]
async fn ai_detect_claude(app: AppHandle) -> Option<String> {
    let home = app.state::<Mutex<App>>().lock().unwrap().home.clone();
    ai::find_claude("", &home).await.map(|p| p.to_string_lossy().into_owned())
}

// Sends a tiny prompt with the current settings; resolves to { text } or { error }.
#[tauri::command]
async fn ai_test(app: AppHandle, system: String) -> Value {
    let (ai, home, workdir) = {
        let state = app.state::<Mutex<App>>();
        let st = state.lock().unwrap();
        (st.settings.ai.clone(), st.home.clone(), st.dir.join("ai-workdir"))
    };
    let mut text = String::new();
    let mut on_text = |t: &str| text.push_str(t);
    let prompt = "Reply with exactly: Hello from your AI provider!";
    match ai::generate(&ai, &home, &workdir, prompt, &system, &mut on_text, &CancellationToken::new()).await {
        Ok(()) => json!({ "text": text }),
        Err(error) => json!({ "error": error }),
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            book_list, book_covers, book_create, book_open, book_pick, book_close, book_current, book_rename, book_color, book_reveal, book_remove,
            fs_list, fs_read, fs_write, fs_rename, fs_nest, fs_move, fs_trash, fs_remove, fs_create,
            settings_get, settings_set, settings_pick_library,
            ai_generate, ai_cancel, ai_detect_claude, ai_test
        ])
        .setup(|app| {
            let paths = app.path();
            let home = paths.home_dir()?;
            let dir = paths.config_dir()?.join("obsidian-clone");
            let documents = paths.document_dir().unwrap_or_else(|_| home.join("Documents"));
            let mut vaults = vaults::load_registry(&dir.join("vaults.json"));
            let settings = settings::load_settings(&dir.join("settings.json"));
            let mut reopen = Vec::new();
            for (id, v) in vaults.iter_mut().filter(|(_, v)| v.open) {
                if v.path.is_dir() { reopen.push(id.clone()) } else { v.open = false }
            }
            app.manage(Mutex::new(App { dir, documents, home, vaults, settings, windows: HashMap::new(), next_window: 0, jobs: HashMap::new(), quitting: false }));
            if reopen.is_empty() {
                create_window(app.handle(), None)?;
            }
            for id in reopen {
                create_window(app.handle(), Some(id))?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                let state = window.state::<Mutex<App>>();
                let mut st = state.lock().unwrap();
                let Some(w) = st.windows.remove(window.label()) else { return };
                // Keep the flag on quit or when the last window closes, so the next launch reopens it.
                if let Some(id) = w.vault.filter(|_| !st.quitting && !st.windows.is_empty()) {
                    st.vaults.get_mut(&id).map(|v| v.open = false);
                    st.save();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the app");
    app.run(|app, event| {
        if let RunEvent::ExitRequested { .. } = event {
            app.state::<Mutex<App>>().lock().unwrap().quitting = true;
        }
    });
}
