// Hides the console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod books;
mod files;
mod images;
mod settings;

use rusqlite::Connection;
use serde_json::{json, Value};
use settings::Settings;
use std::borrow::Cow;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tokio_util::sync::CancellationToken;

struct App {
    // App config folder: settings, the book database and the AI workdir.
    dir: PathBuf,
    home: PathBuf,
    db: Connection,
    settings: Settings,
    // Window label -> the book it shows (None = the library).
    windows: HashMap<String, Option<String>>,
    next_window: u32,
    jobs: HashMap<String, CancellationToken>,
    quitting: bool,
}

type AppState<'a> = State<'a, Mutex<App>>;

impl App {
    fn window_with(&self, id: &str) -> Option<String> {
        self.windows.iter().find(|(_, b)| b.as_deref() == Some(id)).map(|(l, _)| l.clone())
    }

    // Id of the book shown in a window.
    fn book_of(&self, label: &str) -> Result<String, String> {
        self.windows.get(label).cloned().flatten().ok_or_else(|| "Window has no book".into())
    }

    // Points a window at a book (or back at the library).
    fn attach(&mut self, label: &str, id: Option<String>) {
        let old = self.windows.insert(label.to_string(), id.clone()).flatten();
        if let Some(old) = old.filter(|o| Some(o) != id.as_ref()) {
            let _ = books::set_open(&self.db, &old, false);
        }
        if let Some(id) = &id {
            let _ = books::set_open(&self.db, id, true);
        }
    }
}

fn create_window(app: &AppHandle, book: Option<String>) -> Result<(), String> {
    let label = {
        let state = app.state::<Mutex<App>>();
        let mut st = state.lock().unwrap();
        st.next_window += 1;
        let label = format!("w{}", st.next_window);
        st.attach(&label, book);
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

// Opens a book in the calling window (or focuses the window that has it).
fn open_book(app: &AppHandle, window: &WebviewWindow, id: String, new_window: bool) -> Option<String> {
    let other = {
        let state = app.state::<Mutex<App>>();
        let mut st = state.lock().unwrap();
        if let Err(e) = books::title(&st.db, &id) {
            return Some(e);
        }
        let other = st.window_with(&id);
        match &other {
            None if !new_window => st.attach(window.label(), Some(id)),
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

// --- Books (library page) ---

#[tauri::command]
fn book_list(state: AppState) -> Result<Vec<books::Book>, String> {
    books::list(&state.lock().unwrap().db)
}

#[tauri::command]
fn book_covers() -> Vec<&'static str> {
    books::COVERS.to_vec()
}

#[tauri::command]
async fn book_create(app: AppHandle, window: WebviewWindow, title: String, color: String) -> Option<String> {
    let id = books::create(&app.state::<Mutex<App>>().lock().unwrap().db, &title, Some(&color));
    match id {
        Ok(id) => open_book(&app, &window, id, false),
        Err(e) => Some(e),
    }
}

#[tauri::command]
async fn book_open(app: AppHandle, window: WebviewWindow, id: String, new_window: Option<bool>) -> Option<String> {
    open_book(&app, &window, id, new_window.unwrap_or(false))
}

// Copies a folder (or a .zip with `zip`) into a new book and opens it.
#[tauri::command]
async fn book_import(app: AppHandle, window: WebviewWindow, zip: bool) -> Option<String> {
    let dialog = window.dialog().file().set_parent(&window);
    let path = if zip { dialog.add_filter("Zip", &["zip"]).blocking_pick_file() } else { dialog.blocking_pick_folder() }?.into_path().ok()?;
    let id = {
        let state = app.state::<Mutex<App>>();
        let db = &state.lock().unwrap().db;
        if zip { books::import_zip(db, &path) } else { books::import_folder(db, &path) }
    };
    match id {
        Ok(id) => open_book(&app, &window, id, false),
        Err(e) => Some(e),
    }
}

// Saves a book as a .zip of folders and Markdown notes.
#[tauri::command]
async fn book_export(app: AppHandle, window: WebviewWindow, id: String) -> Option<String> {
    let title = books::title(&app.state::<Mutex<App>>().lock().unwrap().db, &id);
    let title = match title {
        Ok(t) => t,
        Err(e) => return Some(e),
    };
    let file = window.dialog().file().set_parent(&window).set_file_name(format!("{title}.zip")).add_filter("Zip", &["zip"]).blocking_save_file()?.into_path().ok()?;
    books::export_zip(&app.state::<Mutex<App>>().lock().unwrap().db, &id, &file).err()
}

#[tauri::command]
async fn book_close(app: AppHandle, window: WebviewWindow) {
    app.state::<Mutex<App>>().lock().unwrap().attach(window.label(), None);
    reload(&window);
}

#[tauri::command]
fn book_current(state: AppState, window: WebviewWindow) -> Option<Value> {
    let st = state.lock().unwrap();
    let id = st.book_of(window.label()).ok()?;
    let title = books::title(&st.db, &id).ok()?;
    Some(json!({ "id": id, "title": title }))
}

#[tauri::command]
fn book_rename(state: AppState, id: String, title: String) -> Option<String> {
    books::rename(&state.lock().unwrap().db, &id, &title).err()
}

#[tauri::command]
fn book_color(state: AppState, id: String, color: String) -> Result<(), String> {
    books::set_color(&state.lock().unwrap().db, &id, &color)
}

#[tauri::command]
fn book_cover(state: AppState, id: String, name: Option<String>) -> Result<(), String> {
    books::set_cover(&state.lock().unwrap().db, &id, name.as_deref())
}

#[tauri::command]
fn book_remove(state: AppState, id: String) -> Option<String> {
    let st = state.lock().unwrap();
    if st.window_with(&id).is_some() {
        return Some("Close the book first".into());
    }
    books::remove(&st.db, &id).err()
}

// --- Notes and folders inside the window's book ---

fn moved(r: Result<String, String>) -> Value {
    match r {
        Ok(path) => json!({ "path": path }),
        Err(error) => json!({ "error": error }),
    }
}

// Runs `f` on the database with the id of the window's book.
fn in_book<T>(state: &AppState, window: &WebviewWindow, f: impl FnOnce(&Connection, &str) -> T) -> Result<T, String> {
    let st = state.lock().unwrap();
    Ok(f(&st.db, &st.book_of(window.label())?))
}

#[tauri::command]
fn fs_list(state: AppState, window: WebviewWindow) -> Result<Vec<files::Entry>, String> {
    in_book(&state, &window, files::list_tree)?
}

#[tauri::command]
fn fs_read(state: AppState, window: WebviewWindow, path: String) -> Result<String, String> {
    in_book(&state, &window, |db, b| files::read(db, b, &path))?
}

#[tauri::command]
fn fs_write(state: AppState, window: WebviewWindow, path: String, text: String) -> Result<(), String> {
    in_book(&state, &window, |db, b| files::write(db, b, &path, &text))?
}

#[tauri::command]
fn fs_rename(state: AppState, window: WebviewWindow, path: String, name: String) -> Result<Value, String> {
    in_book(&state, &window, |db, b| moved(files::rename_entry(db, b, &path, &name)))
}

#[tauri::command]
fn fs_nest(state: AppState, window: WebviewWindow, path: String) -> Result<Value, String> {
    in_book(&state, &window, |db, b| moved(files::nest_note(db, b, &path)))
}

#[tauri::command]
fn fs_move(state: AppState, window: WebviewWindow, path: String, dest: String) -> Result<Value, String> {
    in_book(&state, &window, |db, b| moved(files::move_entry(db, b, &path, &dest)))
}

#[tauri::command]
fn fs_remove(state: AppState, window: WebviewWindow, path: String) -> Result<(), String> {
    in_book(&state, &window, |db, b| files::remove(db, b, &path))?
}

#[tauri::command]
fn fs_create(state: AppState, window: WebviewWindow, folder: bool, parent: Option<String>) -> Result<String, String> {
    in_book(&state, &window, |db, b| files::create_entry(db, b, parent.as_deref().unwrap_or(""), folder))?
}

// --- Settings ---

const MASK: &str = "••••••••";

// The renderer never sees the stored API keys, only whether there are any.
fn public_settings(st: &App) -> Settings {
    let mut s = st.settings.clone();
    for key in [&mut s.ai.openai.api_key, &mut s.image.openai.api_key] {
        if !key.is_empty() {
            *key = MASK.into();
        }
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
    if s.image.openai.api_key == MASK {
        s.image.openai.api_key = st.settings.image.openai.api_key.clone();
    }
    st.settings = s;
    let _ = settings::save_settings(&st.dir.join("settings.json"), &st.settings);
    public_settings(&st)
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

// Generates an image into a book (the window's book when `book` is None); resolves to { name } or { error }.
// Cancelled with ai_cancel, like text.
#[tauri::command]
async fn image_generate(app: AppHandle, window: WebviewWindow, id: String, prompt: String, width: u32, height: u32, book: Option<String>) -> Value {
    let cancel = CancellationToken::new();
    let found = {
        let state = app.state::<Mutex<App>>();
        let mut st = state.lock().unwrap();
        st.jobs.insert(id.clone(), cancel.clone());
        book.map_or_else(|| st.book_of(window.label()), Ok).map(|b| (b, st.settings.image.clone()))
    };
    let r = match found {
        Ok((book, cfg)) => images::generate(&cfg, &prompt, width, height, &cancel).await.and_then(|data| {
            let name = format!("AI image {}.{}", books::now_ms(), images::kind(&data).unwrap().0);
            images::add(&app.state::<Mutex<App>>().lock().unwrap().db, &book, &name, &data).map(|_| name)
        }),
        Err(e) => Err(e),
    };
    app.state::<Mutex<App>>().lock().unwrap().jobs.remove(&id);
    match r {
        Ok(name) => json!({ "name": name }),
        Err(error) => json!({ "error": error }),
    }
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
        .invoke_handler(tauri::generate_handler![
            book_list, book_covers, book_create, book_open, book_import, book_export, book_close, book_current, book_rename, book_color, book_cover, book_remove,
            fs_list, fs_read, fs_write, fs_rename, fs_nest, fs_move, fs_remove, fs_create,
            settings_get, settings_set,
            ai_generate, ai_cancel, ai_detect_claude, ai_test, image_generate
        ])
        // Serves book images at img://localhost/<book id>%2F<name> (see convertFileSrc in the renderer).
        .register_uri_scheme_protocol("img", |ctx, req| {
            let path = percent_encoding::percent_decode_str(req.uri().path().trim_start_matches('/')).decode_utf8_lossy().into_owned();
            let data = path.split_once('/').and_then(|(book, name)| {
                let state = ctx.app_handle().state::<Mutex<App>>();
                let st = state.lock().unwrap();
                images::get(&st.db, book, name).ok().flatten()
            });
            let res = tauri::http::Response::builder();
            match data {
                Some(data) => res.header("content-type", images::kind(&data).map_or("application/octet-stream", |k| k.1)).body(Cow::Owned(data)),
                None => res.status(404).body(Cow::Owned(Vec::new())),
            }
            .unwrap()
        })
        .setup(|app| {
            let paths = app.path();
            let home = paths.home_dir()?;
            let dir = paths.config_dir()?.join("obsidian-clone");
            std::fs::create_dir_all(&dir)?;
            let db = books::open_db(&dir.join("library.db"))?;
            let reopen = books::open_ids(&db)?;
            let settings = settings::load_settings(&dir.join("settings.json"));
            app.manage(Mutex::new(App { dir, home, db, settings, windows: HashMap::new(), next_window: 0, jobs: HashMap::new(), quitting: false }));
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
                let Some(book) = st.windows.remove(window.label()) else { return };
                // Keep the flag on quit or when the last window closes, so the next launch reopens it.
                if let Some(id) = book.filter(|_| !st.quitting && !st.windows.is_empty()) {
                    let _ = books::set_open(&st.db, &id, false);
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
