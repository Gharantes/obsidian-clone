# How to release

The [release.yml](.github/workflows/release.yml) workflow runs when a `v*` tag is pushed to GitHub. It builds the
Windows, Linux and macOS installers, signs the update and publishes everything in a GitHub release, along with the
`latest.json` that the **Settings → About → Check for updates** button reads.

## The automatic way

```sh
npm run release -- patch    # 0.4.0 -> 0.4.1 (also takes minor, major or 0.5.0)
```

[scripts/release.mjs](scripts/release.mjs) does steps 1 to 6 below. It checks that you're on `main` with no
uncommitted changes, asks for confirmation and runs the typecheck and tests. Then it bumps the version in the three
files, commits, and creates and pushes the tag. If the `gh` (GitHub CLI) is installed and logged in, it also watches
the build and checks that the release has `latest.json` and the `.sig` files.

If the version in the files hasn't been released yet, pass that same version (e.g. `npm run release -- 0.0.1`): the
script skips the version commit and only creates the tag.

## Prerequisites (once)

- A `TAURI_SIGNING_PRIVATE_KEY` secret in the repository (Settings → Secrets and variables → Actions) holding the
  contents of `~/.tauri/obsidian-clone.key`:

  ```sh
  gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/obsidian-clone.key
  ```

- The key has no password (the workflow passes an empty `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
- The matching public key is in `plugins.updater.pubkey` in [tauri.conf.json](src-tauri/tauri.conf.json). If you
  change the key, change both; installed copies of an older version won't accept updates signed with the new one.
- The repository must stay public: the app fetches `latest.json` from
  `https://github.com/Gharantes/obsidian-clone/releases/latest/download/latest.json` without logging in.

## Step by step

1. **Make sure `main` is in good shape**

   ```sh
   git checkout main
   git pull
   npm run typecheck
   npm test
   npm run test:rust
   ```

2. **Bump the version in the three files** (same number, without the `v`):

   - [package.json](package.json) → `"version"`
   - [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json) → `"version"`
   - [src-tauri/Cargo.toml](src-tauri/Cargo.toml) → `version` under `[package]`

   The updater compares the installed `tauri.conf.json` version with the one in the release's `latest.json`. If it
   doesn't go up, the app won't see the update, even with a new tag.

   Then run `cargo check --manifest-path src-tauri/Cargo.toml` to update `Cargo.lock`.

3. **Commit the version**

   ```sh
   git add package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
   git commit -m "Version 0.4.0"
   ```

4. **Create the tag and push**

   ```sh
   git tag v0.4.0
   git push
   git push origin v0.4.0
   ```

   The tag has to match the version in the files.

5. **Watch the build** in the GitHub Actions tab (the *Release* workflow). It takes a few minutes per platform.

6. **Check the release** at https://github.com/Gharantes/obsidian-clone/releases:
   - it has the installers (`.msi`/`.exe`, `.deb`/`.AppImage`/`.rpm`, `.dmg`);
   - it has the `.sig` files and `latest.json`;
   - optional: edit the description with what changed.

7. **Test the update**: open an older installed version and click **Settings → About → Check for updates**.

## If something goes wrong

- **The build failed**: fix it on `main`, delete the tag and create it again.

  ```sh
  git tag -d v0.4.0
  git push origin :refs/tags/v0.4.0
  ```

  Also delete the release (if it got created) on the releases page before pushing the tag again.

- **The app doesn't find the update**: check that the `tauri.conf.json` version went up and that the release's
  `latest.json` shows the new number.

## Local build (without publishing)

```sh
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/obsidian-clone.key)"
npm run build
```

The installers end up in `src-tauri/target/release/bundle/`.
