# obsidian-clone

A clone of [Obsidian](https://obsidian.md), the Markdown knowledge base app, shaped around writing books.

- **Library**: the main page is a grid of books. Create a book (title + cover color), or *Import…* a folder or `.zip`
  of Markdown notes. Books live in one SQLite database (`library.db` in the app's config folder), not in folders.
- **Books**: notes are organized in Obsidian's *folder note* style: a folder `Chapter 1` with a note
  `Chapter 1/Chapter 1.md` shows as one item that opens its note. Right-click a note → *New note inside* to nest notes
  under it; drag items to move them. Right-click a book → *Export as .zip* to get it as folders of `.md` files.
- **AI writing**: in a note press **Ctrl+J** (or the ✨ AI button). Type an instruction to write at the cursor, use
  *Continue writing*, or select text to *Rewrite* it. Text streams in highlighted; **Keep** or **Discard**.
  The AI sees the book outline, parent folder notes and the current note.

## AI providers

- **Claude Code** (default): uses your Claude subscription through `claude -p`, no API key. Install Claude Code and run
  `claude` once to log in. The app finds it on PATH, in `~/.local/bin`, or bundled with the VS Code extension.
- **OpenAI-compatible API**: Ollama, LM Studio, Gemini, Groq, OpenRouter… see [FREE_AI_OPTIONS.md](FREE_AI_OPTIONS.md).

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
