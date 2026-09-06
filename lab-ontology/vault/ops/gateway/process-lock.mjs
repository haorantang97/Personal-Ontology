import {
  closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync, writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

const WAIT = new Int32Array(new SharedArrayBuffer(4));
const PROTOCOL = "agent-knowledge-process-lock/v1";
const validKind = (kind) => typeof kind === "string" && kind.trim().length > 0;
const sleep = (ms) => Atomics.wait(WAIT, 0, 0, ms);
const token = () => randomBytes(32).toString("hex");
const timedOut = (lockPath) => Object.assign(new Error(`Timed out waiting for process lock: ${lockPath}`), { code: "PROCESS_LOCK_TIMEOUT" });

function fingerprint(stat) {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

function syncDirectory(directory) {
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function publishOwner(directory, owner) {
  const temporary = path.join(directory, `.owner-${owner.token}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(owner)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temporary, path.join(directory, "owner.json"));
  syncDirectory(directory);
}

function newOwner(kind) {
  return { protocol: PROTOCOL, kind, hostname: os.hostname(), pid: process.pid, token: token(), created_at: new Date().toISOString() };
}

function inspect(directory) {
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const ownerPath = path.join(directory, "owner.json");
    const ownerStat = lstatSync(ownerPath);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) return null;
    const raw = readFileSync(ownerPath, "utf8");
    const owner = JSON.parse(raw);
    if (!owner || owner.protocol !== PROTOCOL || !validKind(owner.kind) || typeof owner.hostname !== "string" || !owner.hostname
      || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || typeof owner.token !== "string" || !/^[a-f0-9]{64}$/.test(owner.token)
      || typeof owner.created_at !== "string" || !Number.isFinite(Date.parse(owner.created_at))) return null;
    return { owner, raw, fingerprint: fingerprint(stat), ownerFingerprint: fingerprint(ownerStat) };
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code) || error instanceof SyntaxError) return null;
    throw error;
  }
}

function identical(a, b) {
  return a && b && a.fingerprint === b.fingerprint && a.ownerFingerprint === b.ownerFingerprint && a.raw === b.raw;
}

function canRecover(state, minDeadAgeMs, kind) {
  if (!state || state.owner.hostname !== os.hostname() || state.owner.kind !== kind) return false;
  const age = Date.now() - Date.parse(state.owner.created_at);
  if (age < minDeadAgeMs || age < 0) return false;
  try { process.kill(state.owner.pid, 0); return false; }
  catch (error) { return error?.code === "ESRCH"; }
}

// A guard serializes *all* namespace mutations, including release. A guard left
// by SIGKILL is intentionally not reclaimed: guessing ownership recreates the
// very initialization/TOCTOU race this protocol prevents. Operators must resolve
// legacy, corrupt, foreign-host and stuck-guard states out of band.
function tryGuard(lockPath) {
  const guardPath = `${lockPath}.recovery`;
  try { mkdirSync(guardPath, { mode: 0o700 }); }
  catch (error) { if (error?.code === "EEXIST") return null; throw error; }
  const owner = newOwner("recovery-guard");
  publishOwner(guardPath, owner);
  return { path: guardPath, kind: owner.kind, token: owner.token, fingerprint: fingerprint(lstatSync(guardPath)) };
}

function quarantineOwned(directory, state, expectedToken, expectedFingerprint, expectedKind) {
  if (!state || state.owner.token !== expectedToken || state.fingerprint !== expectedFingerprint || state.owner.kind !== expectedKind) return false;
  if (!identical(state, inspect(directory))) return false;
  const quarantine = `${directory}.released-${expectedToken}-${token()}`;
  renameSync(directory, quarantine);
  // Never recursively remove a shared pathname. Only remove our unique renamed
  // directory after rechecking ownership; unexpected content remains for review.
  const moved = inspect(quarantine);
  if (!identical(state, moved)) throw Object.assign(new Error(`Lock identity changed during quarantine: ${quarantine}`), { code: "PROCESS_LOCK_IDENTITY_CHANGED" });
  rmSync(quarantine, { recursive: true });
  syncDirectory(path.dirname(directory));
  return true;
}

function releaseGuard(guard) {
  if (!quarantineOwned(guard.path, inspect(guard.path), guard.token, guard.fingerprint, guard.kind)) {
    throw Object.assign(new Error(`Process lock guard ownership changed: ${guard.path}`), { code: "PROCESS_LOCK_GUARD_CHANGED" });
  }
}

function validateOptions(timeoutMs, pollMs, minDeadAgeMs = 0) {
  if (![timeoutMs, pollMs, minDeadAgeMs].every(Number.isFinite) || timeoutMs < 0 || pollMs <= 0 || minDeadAgeMs < 0) {
    throw new TypeError("Lock timeout/age must be nonnegative and poll interval must be positive.");
  }
}

/** Atomic, local-host process lock. Legacy files and ambiguous owners fail closed. */
export function acquireProcessLock(lockPath, {
  timeoutMs = 120_000, pollMs = 100, recoverDeadOwner = false, minDeadAgeMs = 30_000,
  kind = "generic",
} = {}) {
  validateOptions(timeoutMs, pollMs, minDeadAgeMs);
  if (!validKind(kind)) throw new TypeError("Lock kind must be a nonempty string.");
  lockPath = path.resolve(lockPath);
  mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  do {
    const guard = tryGuard(lockPath);
    if (guard) {
      try {
        let claimed = false;
        try { mkdirSync(lockPath, { mode: 0o700 }); claimed = true; }
        catch (error) { if (error?.code !== "EEXIST") throw error; }
        if (!claimed && recoverDeadOwner) {
          const state = inspect(lockPath);
          if (canRecover(state, minDeadAgeMs, kind) && identical(state, inspect(lockPath))
            && quarantineOwned(lockPath, state, state.owner.token, state.fingerprint, kind)) {
            mkdirSync(lockPath, { mode: 0o700 });
            claimed = true;
          }
        }
        if (claimed) {
          const owner = newOwner(kind);
          // If publication fails the empty/partial claim remains fail-closed.
          publishOwner(lockPath, owner);
          syncDirectory(path.dirname(lockPath));
          return { path: lockPath, kind, token: owner.token, fingerprint: fingerprint(lstatSync(lockPath)), owner };
        }
      } finally { releaseGuard(guard); }
    }
    if (Date.now() >= deadline) break;
    sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);
  throw timedOut(lockPath);
}

/** Returns false for a stale handle; never removes a replacement owner's lock. */
export function releaseProcessLock(handle, { timeoutMs = 5_000, pollMs = 25 } = {}) {
  validateOptions(timeoutMs, pollMs);
  if (!handle || typeof handle.path !== "string" || typeof handle.token !== "string" || typeof handle.fingerprint !== "string" || !validKind(handle.kind)) throw new TypeError("Invalid process lock handle.");
  const lockPath = path.resolve(handle.path);
  const deadline = Date.now() + timeoutMs;
  do {
    const guard = tryGuard(lockPath);
    if (guard) {
      try { return quarantineOwned(lockPath, inspect(lockPath), handle.token, handle.fingerprint, handle.kind); }
      finally { releaseGuard(guard); }
    }
    if (Date.now() >= deadline) break;
    sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);
  throw timedOut(lockPath);
}
