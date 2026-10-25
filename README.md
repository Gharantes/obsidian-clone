# obsidian-clone

A clone of [Obsidian](https://obsidian.md), the Markdown knowledge base app, shaped around writing books.

- **Library**: the main page is a grid of books. Create a book (title + cover color), or *Import…* a folder or `.zip`
  of Markdown notes. Books live in one SQLite database (`library.db` in the app's config folder), not in folders.
- **Books**: notes are organized in Obsidian's *folder note* style: a folder `Chapter 1` with a note
  `Chapter 1/Chapter 1.md` shows as one item that opens its note. Right-click a note → *New note inside* to nest notes
  under it; drag items to move them. Right-click a book → *Export as .zip* to get it as folders of `.md` files.
- **Tabs**: open as many notes as you like, or none. Ctrl+click or middle-click a note to open it in a new tab;
  **Ctrl+T** new tab, **Ctrl+W** close, **Ctrl+Tab** next. Drag tabs to reorder; they reopen with the book.
- **AI writing**: in a note press **Ctrl+J** (or the ✨ AI button) to open the AI chat sidebar. Ask for anything —
  write something new, change or cut what's there, answer a question — and it edits the note itself, highlighting
  what it wrote, with **Undo** on its message. Chats are saved with the book; **History** reopens one to carry on
  where you left off. The AI sees the book outline, parent folder notes and the current note.
- **AI images**: ask the AI chat for a picture and it adds one to the note as `![[name.jpg]]`.
  Right-click a book → *Generate cover image…* for an AI cover. Free by default (Pollinations, no key); see
  [FREE_AI_OPTIONS.md](FREE_AI_OPTIONS.md#images-covers-and-pictures-in-notes). Exported zips keep images in `attachments/`.

## AI providers

- **Claude Code** (default): uses your Claude subscription through `claude -p`, no API key. Install Claude Code and run
  `claude` once to log in. The app finds it on PATH, in `~/.local/bin`, or bundled with the VS Code extension.
- **OpenAI-compatible APIs**: Gemini, xAI Grok, Groq, OpenRouter, Ollama, LM Studio… each has its own section in
  Settings for its API key (or server URL). See [FREE_AI_OPTIONS.md](FREE_AI_OPTIONS.md).

Pick the provider and model in the AI sidebar; Settings only holds how to reach each one.

## Develop

Built with [Tauri](https://tauri.app): the UI is in `src/renderer`, the Rust backend in `src-tauri`.
Needs Node and [Rust](https://rustup.rs) (plus the [Tauri prerequisites](https://tauri.app/start/prerequisites/) on Linux).

```sh
npm install
npm run tauri dev  # run the app (same as npm run dev)
npm run build      # installers in src-tauri/target/release/bundle
npm test           # frontend unit tests
npm run test:rust  # backend unit tests
npm run typecheck
```
