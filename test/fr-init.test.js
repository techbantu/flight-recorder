import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { spawnSync } from "node:child_process";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repositoryRoot, "bin", "fr-init.js");
const temporaryDirectories = [];

const makeWorkspace = async () => {
  const workspace = await mkdtemp(join(tmpdir(), "flight-recorder-"));
  temporaryDirectories.push(workspace);
  return workspace;
};

const run = (workspace, ...arguments_) =>
  spawnSync(process.execPath, [cliPath, ...arguments_], {
    cwd: workspace,
    encoding: "utf8",
  });

const runPackageDryRun = () => {
  const options = { cwd: repositoryRoot, encoding: "utf8" };
  const arguments_ = ["pack", "--dry-run", "--json", "--ignore-scripts"];
  if (process.platform !== "win32") {
    return spawnSync("npm", arguments_, options);
  }
  return spawnSync(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/s", "/c", `npm ${arguments_.join(" ")}`],
    options,
  );
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test("creates the complete recorder with deterministic task state", async () => {
  const workspace = await makeWorkspace();
  const result = run(workspace, "Fix share previews");
  const recorder = join(workspace, "ops", "fix-share-previews");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Created flight recorder at ops[/\\]fix-share-previews/);
  assert.deepEqual((await readdir(recorder)).sort(), [
    "checks.md",
    "decisions.log",
    "receipts",
    "resume.md",
    "state.json",
  ]);
  assert.deepEqual(JSON.parse(await readFile(join(recorder, "state.json"), "utf8")), {
    schemaVersion: 1,
    project: "",
    mode: "dev",
    activeTask: "Fix share previews",
    ids: {},
    lastUpdated: null,
  });
  assert.match(
    await readFile(join(recorder, "resume.md"), "utf8"),
    /## Current objective\nFix share previews\n/,
  );
});

test("a retry preserves evidence and repairs only missing artifacts", async () => {
  const workspace = await makeWorkspace();
  const recorder = join(workspace, "ops", "retry-safe");

  assert.equal(run(workspace, "Retry safe").status, 0);
  await writeFile(join(recorder, "decisions.log"), "user evidence\n", "utf8");
  await unlink(join(recorder, "checks.md"));

  const result = run(workspace, "Retry safe");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Repaired flight recorder at ops[/\\]retry-safe/);
  assert.match(result.stdout, /Created: checks\.md/);
  assert.equal(await readFile(join(recorder, "decisions.log"), "utf8"), "user evidence\n");
});

test("a valid state file can recover every later artifact after partial failure", async () => {
  const workspace = await makeWorkspace();
  const recorder = join(workspace, "ops", "recover-partial");

  assert.equal(run(workspace, "Recover partial").status, 0);
  const stateBefore = await readFile(join(recorder, "state.json"), "utf8");
  await Promise.all([
    rm(join(recorder, "decisions.log")),
    rm(join(recorder, "checks.md")),
    rm(join(recorder, "resume.md")),
    rm(join(recorder, "receipts"), { recursive: true }),
  ]);

  const result = run(workspace, "Recover partial");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Repaired flight recorder/);
  assert.equal(await readFile(join(recorder, "state.json"), "utf8"), stateBefore);
  assert.deepEqual((await readdir(recorder)).sort(), [
    "checks.md",
    "decisions.log",
    "receipts",
    "resume.md",
    "state.json",
  ]);
});

test("rejects a task mismatch when different titles collide on one slug", async () => {
  const workspace = await makeWorkspace();
  const recorder = join(workspace, "ops", "fix-bugs");

  assert.equal(run(workspace, "Fix bugs").status, 0);
  const stateBefore = await readFile(join(recorder, "state.json"), "utf8");
  const resumeBefore = await readFile(join(recorder, "resume.md"), "utf8");

  const result = run(workspace, "Fix-bugs");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[E_TASK_MISMATCH\]/);
  assert.equal(await readFile(join(recorder, "state.json"), "utf8"), stateBefore);
  assert.equal(await readFile(join(recorder, "resume.md"), "utf8"), resumeBefore);
});

test("refuses a non-recorder directory without changing it", async () => {
  const workspace = await makeWorkspace();
  const occupied = join(workspace, "occupied");
  await mkdir(occupied);
  await writeFile(join(occupied, "notes.txt"), "keep me\n", "utf8");

  const result = run(workspace, "Do not overwrite", "--dir", "occupied");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[E_TARGET_NOT_EMPTY\]/);
  assert.deepEqual(await readdir(occupied), ["notes.txt"]);
});

test("rejects an unrelated directory with arbitrary state and extra files", async () => {
  const workspace = await makeWorkspace();
  const occupied = join(workspace, "occupied-state");
  const arbitraryState = {
    project: "unrelated",
    mode: "dev",
    activeTask: "Do not overwrite",
    ids: {},
    lastUpdated: null,
  };
  await mkdir(occupied);
  await writeFile(
    join(occupied, "state.json"),
    `${JSON.stringify(arbitraryState, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(occupied, "notes.txt"), "keep me\n", "utf8");

  const result = run(workspace, "Do not overwrite", "--dir", "occupied-state");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[E_STATE_SCHEMA\]/);
  assert.deepEqual((await readdir(occupied)).sort(), ["notes.txt", "state.json"]);
  assert.deepEqual(
    JSON.parse(await readFile(join(occupied, "state.json"), "utf8")),
    arbitraryState,
  );
});

test("rejects malformed recorder state before writing", async () => {
  const workspace = await makeWorkspace();
  const occupied = join(workspace, "malformed-state");
  await mkdir(occupied);
  await writeFile(join(occupied, "state.json"), "{not-json}\n", "utf8");

  const result = run(workspace, "Malformed", "--dir", "malformed-state");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[E_STATE_INVALID\]/);
  assert.deepEqual(await readdir(occupied), ["state.json"]);
  assert.equal(await readFile(join(occupied, "state.json"), "utf8"), "{not-json}\n");
});

test("preflights path conflicts before writing any artifact", async () => {
  const workspace = await makeWorkspace();
  const target = join(workspace, "conflict");
  await mkdir(target);
  await writeFile(join(target, "receipts"), "not a directory\n", "utf8");

  const result = run(workspace, "Path conflict", "--dir", "conflict");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[E_TARGET_TYPE\]/);
  assert.deepEqual(await readdir(target), ["receipts"]);
});

test("rejects invalid task input before creating files", async () => {
  const workspace = await makeWorkspace();
  const result = run(workspace, " \t ");

  assert.equal(result.status, 2);
  assert.match(result.stderr, /\[E_TASK_EMPTY\]/);
  assert.deepEqual(await readdir(workspace), []);
});

test("rejects a missing task as a usage error", async () => {
  const workspace = await makeWorkspace();
  const result = run(workspace);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /\[E_TASK_EMPTY\]/);
  assert.deepEqual(await readdir(workspace), []);
});

test("writes task text containing replacement tokens exactly", async () => {
  const workspace = await makeWorkspace();
  const result = run(workspace, "Fix $& billing");

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    await readFile(join(workspace, "ops", "fix-billing", "resume.md"), "utf8"),
    /## Current objective\nFix \$& billing\n/,
  );
});

test("rejects a target outside the working directory before writing", async () => {
  const workspace = await makeWorkspace();
  const outsideName = `outside-${basename(workspace)}`;
  const outside = join(workspace, "..", outsideName);
  temporaryDirectories.push(outside);
  const result = run(workspace, "Stay contained", "--dir", `../${outsideName}`);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /\[E_DIR_OUTSIDE\]/);
  await assert.rejects(access(outside), { code: "ENOENT" });
});

test("rejects a recorder directory that cannot be represented portably", async () => {
  const workspace = await makeWorkspace();
  const result = run(
    workspace,
    "Portable recorder",
    "--dir",
    "ops/portable:alternate-stream",
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /\[E_DIR_PORTABLE\]/u);
  assert.deepEqual(await readdir(workspace), []);
});

test("rejects a symlinked target ancestor before writing outside", async () => {
  const workspace = await makeWorkspace();
  const outside = await makeWorkspace();
  await symlink(outside, join(workspace, "linked"), "dir");

  const result = run(workspace, "Stay physically contained", "--dir", "linked/task");

  assert.equal(result.status, 2);
  assert.match(result.stderr, /\[E_DIR_SYMLINK\]/);
  assert.deepEqual(await readdir(outside), []);
});

test("the Claude Code adapter declares an explicit-only least-capability surface", async () => {
  const manifest = JSON.parse(
    await readFile(join(repositoryRoot, ".claude-plugin", "plugin.json"), "utf8"),
  );
  const packageMetadata = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  const skill = await readFile(
    join(repositoryRoot, "skills", "init", "SKILL.md"),
    "utf8",
  );

  assert.equal(manifest.name, "flight-recorder");
  assert.equal(manifest.version, packageMetadata.version);
  assert.deepEqual(await readdir(join(repositoryRoot, "skills")), ["init"]);
  [
    "agents",
    "dependencies",
    "hooks",
    "lspServers",
    "mcpServers",
    "monitors",
    "settings",
  ].forEach((field) => assert.equal(field in manifest, false, `unexpected ${field}`));
  assert.match(skill, /^disable-model-invocation: true$/mu);
  assert.match(skill, /^user-invocable: true$/mu);
  assert.match(
    skill,
    /node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/fr-init\.js".*`--`/u,
  );
  assert.doesNotMatch(skill, /^allowed-tools:/mu);
  assert.doesNotMatch(skill, /!\s*`/u);
});

test("the plugin-root invocation initializes a shell-like task as literal data", async () => {
  const workspace = await makeWorkspace();
  const task = "Review --dir ../literal; $(not-run)";
  const environment = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: repositoryRoot,
    PATH: dirname(process.execPath),
  };
  const result = spawnSync(
    "node",
    [join(environment.CLAUDE_PLUGIN_ROOT, "bin", "fr-init.js"), "--", task],
    {
      cwd: workspace,
      encoding: "utf8",
      env: environment,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Created flight recorder/u);
  assert.match(
    await readFile(
      join(workspace, "ops", "review-dir-literal-not-run", "resume.md"),
      "utf8",
    ),
    /## Current objective\nReview --dir \.\.\/literal; \$\(not-run\)\n/u,
  );
  assert.deepEqual(await readdir(workspace), ["ops"]);
});

test("the package contains every advertised executable and template", () => {
  const result = runPackageDryRun();

  assert.equal(result.status, 0, result.stderr);
  const [{ files }] = JSON.parse(result.stdout);
  const paths = new Set(files.map(({ path }) => path));

  [
    ".claude-plugin/plugin.json",
    "bin/fr.js",
    "bin/fr-init.js",
    "docs/HANDOFF_V1.md",
    "schema/command-receipt-v1.schema.json",
    "schema/handoff-v1.schema.json",
    "skills/init/SKILL.md",
    "templates/checks.md",
    "templates/decisions.log",
    "templates/resume.md",
    "templates/state.json",
  ].forEach((path) => assert.equal(paths.has(path), true, `missing from package: ${path}`));
});
