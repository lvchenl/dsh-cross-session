/**
 * Persistent cross-session registry for dsh-cross-session.
 *
 * State lives under `<workspace>/<stateDir>/registry.json` (default
 * `.cross-session`). Writes are serialized through a process-local promise
 * chain (a process-local lock; cross-process safety is best-effort via an
 * atomic temp+rename write) so concurrent tool calls cannot interleave.
 *
 * @module dsh-cross-session/state
 */
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Process-local serialization chain for registry writes. */
let chain = Promise.resolve();

/** Empty registry shape. */
function empty() {
  return { workers: {} };
}

/**
 * Absolute registry path for one workspace.
 * @param {string} workspace - workspace root directory.
 * @param {string} stateDir - configured state directory name.
 * @returns {string} absolute registry.json path.
 */
export function registryPath(workspace, stateDir) {
  return join(workspace, stateDir, 'registry.json');
}

/**
 * Read the registry, returning a fresh object on any failure.
 * @param {string} path - absolute registry.json path.
 * @returns {Promise<{workers: Record<string, object>}>}
 */
async function readRegistry(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.workers) return parsed;
  } catch {
    // missing or corrupt — start fresh
  }
  return empty();
}

/**
 * Write the registry atomically (write temp file then rename over target).
 * Rename within the same directory is atomic on POSIX and on Windows
 * (same volume); a leftover temp file is removed on failure.
 * @param {string} path - absolute registry.json path.
 * @param {object} registry - full registry value.
 * @returns {Promise<void>}
 */
async function writeRegistry(path, registry) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(registry, null, 2), 'utf8');
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Run one read-modify-write against the registry under the process-local lock.
 * @param {string} workspace - workspace root directory.
 * @param {string} stateDir - configured state directory name.
 * @param {(registry: object) => void | Promise<void>} mutate - mutation callback.
 * @returns {Promise<object>} the registry after mutation.
 */
export function withRegistry(workspace, stateDir, mutate) {
  const run = chain.then(async () => {
    const path = registryPath(workspace, stateDir);
    const registry = await readRegistry(path);
    await mutate(registry);
    await writeRegistry(path, registry);
    return registry;
  });
  // Keep the chain alive even when a mutation throws; callers see the error.
  chain = run.then(() => undefined, () => undefined);
  return run;
}
