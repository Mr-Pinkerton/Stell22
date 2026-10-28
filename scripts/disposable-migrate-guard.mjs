/**
 * Fail closed before a disposable `prisma migrate deploy`.
 * Structural checks do not open a connection.
 */
import fs from "node:fs";
import path from "node:path";

export class DisposableMigrateRefusal extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "DisposableMigrateRefusal";
    this.code = code;
  }
}

export const PERSISTENT_DATABASE_NAMES = [
  "stell22",
  "stell22_dev",
  "stell22_integrity",
  "stell22_smoke",
  "stell22_inc001_dry",
];

/**
 * These ports are refused because local Stell22 databases publish them.
 * Refusing them does not prove that this process owns a disposable
 * container: a persistent database can listen on an ephemeral port, and a
 * disposable container can publish one of these fixed ports.
 */
export const PERSISTENT_HOST_PORTS = [5432, 5433, 5434];

const APPROVED_DATABASE = /^(?:p1disp|p1gate|p1as|p1rec|p1iso|acrel|stell22_restore_drill)_[a-z0-9_]+$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost"]);

/**
 * @param {string | undefined} raw
 */
export function parseDisposableDatabaseUrl(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new DisposableMigrateRefusal("ABSENT_URL", "Disposable DATABASE_URL is absent");
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new DisposableMigrateRefusal("MALFORMED_URL", "Disposable DATABASE_URL is not a URL");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new DisposableMigrateRefusal("MALFORMED_URL", "Disposable DATABASE_URL is not PostgreSQL");
  }
  if (!LOOPBACK.has(url.hostname)) {
    throw new DisposableMigrateRefusal("NON_LOOPBACK", "Disposable DATABASE_URL host is not loopback");
  }
  const port = url.port === "" ? 5432 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DisposableMigrateRefusal("MALFORMED_URL", "Disposable DATABASE_URL port is invalid");
  }
  if (PERSISTENT_HOST_PORTS.includes(port)) {
    throw new DisposableMigrateRefusal("PERSISTENT_PORT", "Disposable DATABASE_URL uses a persistent local port");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, "").split("/")[0] ?? "").toLowerCase();
  if (PERSISTENT_DATABASE_NAMES.includes(database)) {
    throw new DisposableMigrateRefusal("PERSISTENT_DATABASE", "Disposable DATABASE_URL names a persistent database");
  }
  if (!APPROVED_DATABASE.test(database)) {
    throw new DisposableMigrateRefusal("UNAPPROVED_DATABASE", "Disposable DATABASE_URL database name is not approved");
  }
  return { database, port, host: url.hostname, href: raw };
}

/**
 * The candidate must exist and its physical path, after `..` normalization
 * and symbolic-link resolution, must lie outside the repository.
 * A missing or unresolvable path is refused. It is not treated as external.
 *
 * @param {string} candidate
 * @param {string} repositoryRoot
 */
export function assertOutsideRepository(candidate, repositoryRoot) {
  const candidateReal = canonicalPath(candidate);
  const rootReal = canonicalPath(repositoryRoot);
  const relative = path.relative(rootReal, candidateReal);
  const escaped = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (!escaped) {
    throw new DisposableMigrateRefusal(
      "INSIDE_REPOSITORY",
      "Prisma working directory or schema is inside the repository",
    );
  }
}

/**
 * @param {string} value
 */
function canonicalPath(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DisposableMigrateRefusal("UNVERIFIABLE_PATH", "Prisma path is missing or malformed");
  }
  try {
    return fs.realpathSync.native(path.resolve(value));
  } catch {
    throw new DisposableMigrateRefusal("UNVERIFIABLE_PATH", "Prisma path cannot be resolved");
  }
}
