import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { acquireProcessLock, releaseProcessLock } from "./process-lock.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "process-lock-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, lock: path.join(root, "shared.lock") };
}
const immediate = { timeoutMs: 0, pollMs: 1, recoverDeadOwner: true, minDeadAgeMs: 0 };
function deadPid() {
  const result = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  return Number(result.stdout);
}
function owner(overrides = {}) {
  return { protocol: "agent-knowledge-process-lock/v1", kind: "generic", hostname: os.hostname(), pid: deadPid(), token: randomBytes(32).toString("hex"), created_at: new Date(Date.now() - 60_000).toISOString(), ...overrides };
}
function install(lock, record) {
  mkdirSync(lock);
  writeFileSync(path.join(lock, "owner.json"), JSON.stringify(record));
}
function assertBusy(lock, options = immediate) {
  assert.throws(() => acquireProcessLock(lock, options), { code: "PROCESS_LOCK_TIMEOUT" });
}

test("claim initialization window is never reclaimed", (t) => {
  const { lock } = fixture(t);
  mkdirSync(lock);
  assertBusy(lock);
  assert.deepEqual(readdirSync(lock), []);
  writeFileSync(path.join(lock, ".owner-in-progress.tmp"), "partial");
  assertBusy(lock);
  assert.equal(readFileSync(path.join(lock, ".owner-in-progress.tmp"), "utf8"), "partial");
});

test("a published owner is complete and release is idempotent", (t) => {
  const { lock, root } = fixture(t);
  const handle = acquireProcessLock(lock, immediate);
  assert.deepEqual(JSON.parse(readFileSync(path.join(lock, "owner.json"), "utf8")), handle.owner);
  assertBusy(lock);
  assert.equal(releaseProcessLock(handle), true);
  assert.equal(releaseProcessLock(handle), false);
  assert.deepEqual(readdirSync(root), []);
});

test("stale handle cannot delete a newly acquired owner", (t) => {
  const { lock } = fixture(t);
  const first = acquireProcessLock(lock, immediate);
  releaseProcessLock(first);
  const second = acquireProcessLock(lock, immediate);
  assert.equal(releaseProcessLock(first), false);
  assert.equal(JSON.parse(readFileSync(path.join(lock, "owner.json"), "utf8")).token, second.token);
  releaseProcessLock(second);
});

test("dead owner requires explicit recovery and sufficient age", (t) => {
  const { lock } = fixture(t);
  install(lock, owner());
  assertBusy(lock, { ...immediate, recoverDeadOwner: false });
  assertBusy(lock, { ...immediate, minDeadAgeMs: 120_000 });
  const handle = acquireProcessLock(lock, immediate);
  assert.equal(handle.owner.pid, process.pid);
  releaseProcessLock(handle);
});

for (const [name, make] of [
  ["foreign host", () => owner({ hostname: `${os.hostname()}-foreign` })],
  ["current pid", () => owner({ pid: process.pid })],
  ["unknown protocol", () => owner({ protocol: "agent-knowledge-process-lock/v2" })],
  ["missing protocol", () => owner({ protocol: undefined })],
  ["invalid kind", () => owner({ kind: " " })],
  ["different kind", () => owner({ kind: "approval" })],
  ["invalid token", () => owner({ token: "invalid" })],
  ["invalid pid", () => owner({ pid: -1 })],
  ["future owner", () => owner({ created_at: new Date(Date.now() + 60_000).toISOString() })],
]) {
  test(`${name} fails closed`, (t) => {
    const { lock } = fixture(t);
    const record = make();
    install(lock, record);
    assertBusy(lock);
    assert.deepEqual(JSON.parse(readFileSync(path.join(lock, "owner.json"), "utf8")), JSON.parse(JSON.stringify(record)));
  });
}

test("explicit kind survives handle and wrong-kind release fails closed", (t) => {
  const { lock } = fixture(t);
  const handle = acquireProcessLock(lock, { ...immediate, kind: "approval" });
  assert.equal(handle.kind, "approval");
  assert.equal(handle.owner.kind, "approval");
  assert.equal(handle.owner.protocol, "agent-knowledge-process-lock/v1");
  assert.equal(releaseProcessLock({ ...handle, kind: "native-build" }), false);
  assert.equal(JSON.parse(readFileSync(path.join(lock, "owner.json"), "utf8")).token, handle.token);
  assert.equal(releaseProcessLock(handle), true);
});

test("blank acquire kind is rejected before changing files", (t) => {
  const { lock, root } = fixture(t);
  for (const kind of ["", "  ", null, 1]) assert.throws(() => acquireProcessLock(lock, { ...immediate, kind }), TypeError);
  assert.deepEqual(readdirSync(root), []);
});

test("legacy files and invalid JSON are retained", (t) => {
  const { lock, root } = fixture(t);
  writeFileSync(lock, "123\n");
  assertBusy(lock);
  assert.equal(readFileSync(lock, "utf8"), "123\n");
  const other = path.join(root, "invalid.lock");
  mkdirSync(other);
  writeFileSync(path.join(other, "owner.json"), "{");
  assertBusy(other);
  assert.equal(readFileSync(path.join(other, "owner.json"), "utf8"), "{");
});

test("unknown process-probe failure is not proof of death", (t) => {
  const { lock } = fixture(t);
  const record = owner();
  install(lock, record);
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("permission denied"), { code: "EPERM" }); });
  assertBusy(lock);
  assert.deepEqual(JSON.parse(readFileSync(path.join(lock, "owner.json"), "utf8")), record);
});

test("stuck recovery guard prevents acquire and release without mutation", (t) => {
  const { lock } = fixture(t);
  const handle = acquireProcessLock(lock, immediate);
  mkdirSync(`${lock}.recovery`);
  assertBusy(lock);
  assert.throws(() => releaseProcessLock(handle, { timeoutMs: 0 }), { code: "PROCESS_LOCK_TIMEOUT" });
  assert.ok(existsSync(lock));
  assert.deepEqual(readdirSync(`${lock}.recovery`), []);
});

async function concurrentHolders(t, recover) {
  const { lock, root } = fixture(t);
  if (recover) install(lock, owner());
  const moduleUrl = new URL("./process-lock.mjs", import.meta.url).href;
  const code = `import {acquireProcessLock,releaseProcessLock} from ${JSON.stringify(moduleUrl)};
    import {mkdirSync,rmdirSync} from 'node:fs';
    const lock=acquireProcessLock(process.argv[1],{timeoutMs:20000,pollMs:5,recoverDeadOwner:${recover},minDeadAgeMs:0});
    mkdirSync(process.argv[2]);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
    rmdirSync(process.argv[2]); releaseProcessLock(lock);`;
  const results = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, lock, path.join(root, "critical")], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stderr }));
  })));
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(root), []);
}

test("concurrent processes have exactly one holder at a time", async (t) => concurrentHolders(t, false));
test("concurrent recoverers retain exactly one holder", async (t) => concurrentHolders(t, true));

test("all production lock domains use the neutral process-lock protocol", () => {
  const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  const native = readFileSync(new URL("./retrieval-index.mjs", import.meta.url), "utf8");
  for (const source of [server, native]) {
    assert.match(source, /from "\.\/process-lock\.mjs"/);
    assert.match(source, /acquireProcessLock\(/);
    assert.match(source, /releaseProcessLock\(/);
  }
  assert.match(server, /kind: "proposal-approval"/);
  assert.match(native, /kind: "native-index-build"/);
});
