/**
 * Allowlist for a future disposable Prisma child.
 * Windows environment blocks treat keys case-insensitively, so matching is
 * case-insensitive and the child object keeps one canonical key.
 * A case collision on an allowed key drops that key.
 * DATABASE_URL is set only from the disposable URL argument.
 */
const ALLOWED_KEYS = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
]);

export function buildChildEnv(
  parent: Readonly<Record<string, string | undefined>>,
  disposableUrl: string,
): Record<string, string> {
  const selected = new Map<string, string | null>();
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    const canonical = key.toUpperCase();
    if (!ALLOWED_KEYS.has(canonical)) continue;
    if (selected.has(canonical)) {
      selected.set(canonical, null);
      continue;
    }
    selected.set(canonical, value);
  }
  const env: Record<string, string> = {};
  for (const [key, value] of selected) {
    if (value !== null) env[key] = value;
  }
  env.DATABASE_URL = disposableUrl;
  return env;
}
