/**
 * Auto-update check for Magector CLI.
 *
 * On each CLI run (except help/mcp), checks the npm registry for a newer version.
 * If found, re-execs the current command via `npx magector@<latest>` so npx
 * downloads the new version and runs it. Results are cached for 1 hour.
 *
 * Never blocks the CLI on failure — network errors are silently ignored.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_TTL = 3600000; // 1 hour
const REGISTRY_TIMEOUT = 3000; // 3 seconds
const SKIP_COMMANDS = new Set(['help', '--help', '-h', 'mcp', undefined]);

/**
 * Read current package version.
 */
function getCurrentVersion() {
  const pkgPath = path.resolve(__dirname, '..', 'package.json');
  if (!existsSync(pkgPath)) return null;
  return JSON.parse(readFileSync(pkgPath, 'utf-8')).version;
}

/**
 * Resolve cache file path — prefer project .magector/ if it exists, else ~/.magector/
 */
function getCachePath() {
  const projectDir = path.join(process.cwd(), '.magector');
  if (existsSync(projectDir)) {
    return path.join(projectDir, 'version-check.json');
  }
  const globalDir = path.join(homedir(), '.magector');
  mkdirSync(globalDir, { recursive: true });
  return path.join(globalDir, 'version-check.json');
}

/**
 * Read cached version check result.
 */
function readCache(cachePath) {
  try {
    if (!existsSync(cachePath)) return null;
    return JSON.parse(readFileSync(cachePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Write cache.
 */
function writeCache(cachePath, latest) {
  try {
    writeFileSync(cachePath, JSON.stringify({ latest, checkedAt: Date.now() }));
  } catch {
    // Non-critical
  }
}

/**
 * Compare two semver strings. Returns true if a > b.
 */
function isNewer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

/**
 * Fetch latest version from npm registry using native fetch (Node 18+).
 */
async function fetchLatestVersion() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT);
  try {
    const resp = await fetch('https://registry.npmjs.org/magector/latest', {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.version || null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check for updates and self-update if a newer version is available.
 *
 * When a newer version is found, re-execs the CLI command via
 * `npx -y magector@<latest> <original args>` so npx downloads
 * the new version automatically. The current process exits after.
 *
 * @param {string} command - The CLI command being run
 * @param {string[]} originalArgs - The original process.argv.slice(2)
 */
export async function checkForUpdate(command, originalArgs) {
  // Skip for commands that don't need update checks
  if (SKIP_COMMANDS.has(command)) return;

  // Skip if MAGECTOR_NO_UPDATE is set (for CI, testing, or re-exec guard)
  if (process.env.MAGECTOR_NO_UPDATE) return;

  try {
    const current = getCurrentVersion();
    if (!current) return;

    const cachePath = getCachePath();
    const cached = readCache(cachePath);

    // Cache hit — check if we already know about an update
    if (cached && (Date.now() - cached.checkedAt) < CACHE_TTL) {
      if (!isNewer(cached.latest, current)) return; // up to date
      // Cached says there's an update — proceed to re-exec
      return reExec(current, cached.latest, originalArgs);
    }

    // Fetch from registry
    const latest = await fetchLatestVersion();
    if (!latest) return;

    writeCache(cachePath, latest);

    if (!isNewer(latest, current)) return; // up to date

    return reExec(current, latest, originalArgs);
  } catch {
    // Never block CLI on update check failure
  }
}

/**
 * Re-exec the current command with the latest version.
 */
function reExec(current, latest, originalArgs) {
  console.log(`\n⬆  Updating magector: v${current} → v${latest}...\n`);
  try {
    const cmd = `npx -y magector@${latest} ${originalArgs.join(' ')}`;
    execSync(cmd, {
      stdio: 'inherit',
      env: { ...process.env, MAGECTOR_NO_UPDATE: '1' }
    });
  } catch (err) {
    process.exit(err.status || 1);
  }
  process.exit(0);
}
