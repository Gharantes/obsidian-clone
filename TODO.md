# TODO — Obsidian clone with REA

Target: `~/.config/obsidian/obsidian-1.14.4.asar` (the build Obsidian actually runs;
`/usr/lib/obsidian/obsidian.asar` is the older 1.13.7 shipped by pacman).

Rule: REA explains *how* Obsidian does something. We write our own code from that.
Never paste Obsidian's code into this repo. Raw analysis output goes in `analysis/` (gitignored).

---

## Phase 0 — Fix setup (blocker, ~5 min)

- [x] Run `npx rea-agents@latest setup --client claude_code --yes`
- [x] Verify: `claude mcp list | grep -i rea` shows `rea: ... ✔ Connected`
- [x] Restart VS Code (or the `claude` CLI)
- [x] Verify in Claude: "Call REA's `binary_session` tool" returns a version

No Hopper/Ghidra/IDA needed: Obsidian is Electron, static JS analysis covers it.

## Phase 1 — Map the app (~20 min)

- [x] Ask Claude:
  > Using REA, analyze the Electron app at `~/.config/obsidian/obsidian-1.14.4.asar`.
  > Save the raw result to `analysis/overview.json` and write `analysis/overview.md`:
  > main vs renderer modules, IPC channels, bundled libraries (with versions), and
  > where the vault/file I/O happens.
- [ ] Read `analysis/overview.md`. Editor confirmed: CodeMirror 6

Analyzing the whole ASAR times out on the bundled `lib/pdfjs`. Pass `source_paths`
`["package.json","main.js","index.html","starter.html","starter.js","enhance.js","worker.js","app.js"]`.

## Phase 2 — Scaffold (~1 h)

- [x] Scaffold Electron 44 + electron-vite + TypeScript, with a bare CodeMirror 6 editor
- [ ] `npm install && npm run dev` opens a window with a Markdown editor

If the window never opens, run `unset ELECTRON_RUN_AS_NODE` first (VS Code sets it).

## Phase 3 — Features, one at a time (~1–3 h each)

Use the same prompt for every feature:

> Using REA on `~/.config/obsidian/obsidian-1.14.4.asar`, trace how Obsidian implements
> **<FEATURE>**. Put evidence in `analysis/<feature>.md`. Then implement our own version in
> this repo, with one test, and tell me how to try it.

Tick each one only after you tried it in the running app.

**MVP**
- [ ] Open a folder as a vault
- [ ] File explorer sidebar (create / rename / delete notes)
- [ ] Markdown editor with live preview
- [ ] `[[wikilinks]]` + click to open
- [ ] Backlinks panel

**Next**
- [ ] Quick switcher (Ctrl+O)
- [ ] Full-text search
- [ ] Tags
- [ ] Command palette (Ctrl+P)
- [ ] Graph view

**Later**: settings screen, themes, plugin API, tabs/splits.

Shortcut: Obsidian's public plugin API types (`npm view obsidian`) name most internal
concepts (`Vault`, `Workspace`, `MetadataCache`). Reading them first makes REA prompts sharper.

---

## If something breaks

- Tools missing in Claude → `npx -y rea-agents@latest doctor --client claude_code --json`
- REA updated → re-run `npx rea-agents@latest setup`, restart
