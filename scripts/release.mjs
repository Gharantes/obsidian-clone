// Runs the release described in RELEASE.md.
// Usage: npm run release -- <patch|minor|major|x.y.z>
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const REPO = "Gharantes/obsidian-clone";
const FILES = {
  pkg: "package.json",
  tauri: "src-tauri/tauri.conf.json",
  cargo: "src-tauri/Cargo.toml",
};

function run(cmd) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

function out(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function fail(msg) {
  console.error(`\nError: ${msg}`);
  process.exit(1);
}

function nextVersion(current, arg) {
  if (/^\d+\.\d+\.\d+$/.test(arg)) return arg;
  const [major, minor, patch] = current.split(".").map(Number);
  if (arg === "major") return `${major + 1}.0.0`;
  if (arg === "minor") return `${major}.${minor + 1}.0`;
  if (arg === "patch") return `${major}.${minor}.${patch + 1}`;
  fail("pass patch, minor, major or a version x.y.z (e.g. npm run release -- minor)");
}

function replaceVersion(file, regex, version) {
  const text = readFileSync(file, "utf8");
  if (!regex.test(text)) fail(`version not found in ${file}`);
  writeFileSync(file, text.replace(regex, (_, before) => `${before}${version}"`));
}

function hasGh() {
  try {
    out("gh --version");
    return true;
  } catch {
    return false;
  }
}

// 1. Checks
if (out("git rev-parse --abbrev-ref HEAD") !== "main") fail("switch to the main branch");
if (out("git status --porcelain")) fail("there are uncommitted changes");
run("git pull --ff-only");

const current = JSON.parse(readFileSync(FILES.tauri, "utf8")).version;
const version = nextVersion(current, process.argv[2]);
const tag = `v${version}`;

if (out(`git tag -l ${tag}`)) fail(`tag ${tag} already exists`);
if (out(`git ls-remote --tags origin refs/tags/${tag}`)) fail(`tag ${tag} already exists on GitHub`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(`\nCurrent version ${current} -> release ${tag}? (y/N) `);
rl.close();
if (answer.trim().toLowerCase() !== "y") fail("cancelled");

run("npm run typecheck");
run("npm test");
run("npm run test:rust");

// 2 and 3. Bump the version and commit
if (version !== current) {
  replaceVersion(FILES.pkg, /("version":\s*")[^"]+"/, version);
  replaceVersion(FILES.tauri, /("version":\s*")[^"]+"/, version);
  replaceVersion(FILES.cargo, /(\[package\][^[]*?\nversion\s*=\s*")[^"]+"/, version);
  run("npm install --package-lock-only --silent");
  run("cargo check --manifest-path src-tauri/Cargo.toml");
  run(`git add ${Object.values(FILES).join(" ")} package-lock.json src-tauri/Cargo.lock`);
  run(`git commit -m "Version ${version}"`);
}

// 4. Tag and push
run(`git tag ${tag}`);
run("git push");
run(`git push origin ${tag}`);

// 5 and 6. Watch the build and check the release
const releaseUrl = `https://github.com/${REPO}/releases/tag/${tag}`;
if (!hasGh()) {
  console.log(`\nTag pushed. Watch the Actions tab and check the release at ${releaseUrl}`);
  process.exit(0);
}

const sha = out("git rev-parse HEAD");
let runId = "";
for (let i = 0; i < 20 && !runId; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  runId = out(
    `gh run list --workflow release.yml --commit ${sha} --limit 1 --json databaseId --jq ".[0].databaseId"`,
  );
}
if (!runId) fail("the Release workflow didn't show up; check the Actions tab");

try {
  run(`gh run watch ${runId} --exit-status`);
} catch {
  fail(`the build failed. See RELEASE.md, "If something goes wrong"`);
}

const assets = out(`gh release view ${tag} --json assets --jq ".assets[].name"`).split("\n");
console.log(`\nRelease files:\n  ${assets.join("\n  ")}`);
if (!assets.includes("latest.json")) fail("the release has no latest.json");
if (!assets.some((a) => a.endsWith(".sig"))) fail("the release has no .sig files");

console.log(`\nRelease ${tag} published: ${releaseUrl}`);
console.log("Test it with Settings -> About -> Check for updates on an older installed version.");
