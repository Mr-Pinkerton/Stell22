import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  AUTHORIZED_REPOSITORY_COMMIT,
  AUTHORIZED_REPOSITORY_TREE,
  EXPECTED_MIGRATION_SQL_COUNT,
  P1_GIT_BLOB,
  P1_MIGRATION_PATH,
  P1_SHA256,
} from "@/server/internal/p1-isolated-runner/contract";
import {
  PINNED_MIGRATION_FILES,
  PINNED_SCHEMA_PRISMA,
} from "@/server/internal/p1-isolated-runner/inventory";
import { refusal } from "@/server/internal/p1-isolated-runner/refusal";

export type GitTreeEntry = { path: string; gitBlob: string };

export type GitBlobSource = {
  resolveCommit(commit: string): { commit: string; tree: string };
  listMigrationTree(commit: string): readonly GitTreeEntry[];
  resolvePathBlob(commit: string, path: string): string;
  readBlob(gitBlob: string): Buffer;
};

export type VerifiedMigrationBytes = {
  files: ReadonlyArray<{ path: string; gitBlob: string; sha256: string; bytes: Buffer }>;
  digest: string;
};

export type MaterializedMigrationSet = {
  root: string;
  schemaPath: string;
  digest: string;
};

const HEX_40 = /^[0-9a-f]{40}$/;

export function assertHex40(value: string, label: string): void {
  if (!HEX_40.test(value)) {
    throw refusal("STOP", "MALFORMED_GIT_OBJECT", `${label} is not a git object id`);
  }
}

export function verifyAuthorizedMigrationBytes(source: GitBlobSource): VerifiedMigrationBytes {
  const resolved = source.resolveCommit(AUTHORIZED_REPOSITORY_COMMIT);
  if (
    resolved.commit !== AUTHORIZED_REPOSITORY_COMMIT ||
    resolved.tree !== AUTHORIZED_REPOSITORY_TREE
  ) {
    throw refusal(
      "STOP",
      "WRONG_REPOSITORY_COMMIT",
      "Repository commit or tree does not match the pin",
    );
  }

  const listed = [...source.listMigrationTree(AUTHORIZED_REPOSITORY_COMMIT)].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  const pinned = [...PINNED_MIGRATION_FILES].sort((a, b) => a.path.localeCompare(b.path));
  if (listed.length !== pinned.length) {
    throw refusal(
      "STOP",
      "MIGRATION_INVENTORY_MISMATCH",
      "Migration inventory count does not match the pin",
    );
  }
  for (let index = 0; index < pinned.length; index += 1) {
    const expected = pinned[index];
    const actual = listed[index];
    if (
      !expected ||
      !actual ||
      actual.path !== expected.path ||
      actual.gitBlob !== expected.gitBlob
    ) {
      throw refusal(
        "STOP",
        "MIGRATION_INVENTORY_MISMATCH",
        "Migration path or blob does not match the pin",
      );
    }
  }

  const sqlCount = pinned.filter((entry) => entry.path.endsWith("/migration.sql")).length;
  if (sqlCount !== EXPECTED_MIGRATION_SQL_COUNT) {
    throw refusal(
      "STOP",
      "MIGRATION_INVENTORY_MISMATCH",
      "Migration SQL count does not match the pin",
    );
  }
  const p1 = pinned.find((entry) => entry.path === P1_MIGRATION_PATH);
  if (!p1 || p1.gitBlob !== P1_GIT_BLOB || p1.sha256 !== P1_SHA256) {
    throw refusal("STOP", "P1_PIN_MISMATCH", "P1 blob or SHA-256 does not match the pin");
  }

  const schemaBlob = source.resolvePathBlob(
    AUTHORIZED_REPOSITORY_COMMIT,
    PINNED_SCHEMA_PRISMA.path,
  );
  if (schemaBlob !== PINNED_SCHEMA_PRISMA.gitBlob) {
    throw refusal("STOP", "SCHEMA_BLOB_MISMATCH", "schema.prisma blob does not match the pin");
  }

  const files: Array<{ path: string; gitBlob: string; sha256: string; bytes: Buffer }> = pinned.map(
    (entry) => {
      assertHex40(entry.gitBlob, entry.path);
      const bytes = Buffer.from(source.readBlob(entry.gitBlob));
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== entry.sha256) {
        throw refusal(
          "STOP",
          "MIGRATION_BYTES_MISMATCH",
          `Bytes for ${entry.path} do not match the pin`,
        );
      }
      return { path: entry.path, gitBlob: entry.gitBlob, sha256, bytes };
    },
  );
  const schemaBytes = Buffer.from(source.readBlob(schemaBlob));
  const schemaSha = createHash("sha256").update(schemaBytes).digest("hex");
  if (schemaSha !== PINNED_SCHEMA_PRISMA.sha256) {
    throw refusal("STOP", "SCHEMA_BYTES_MISMATCH", "schema.prisma bytes do not match the pin");
  }
  files.push({
    path: PINNED_SCHEMA_PRISMA.path,
    gitBlob: schemaBlob,
    sha256: schemaSha,
    bytes: schemaBytes,
  });

  return {
    files,
    digest: digestOf(files.map((file) => ({ path: file.path, sha256: file.sha256 }))),
  };
}

export function materializeMigrationSet(
  source: GitBlobSource,
  destinationRoot: string,
): MaterializedMigrationSet {
  const verified = verifyAuthorizedMigrationBytes(source);
  if (fs.existsSync(destinationRoot)) {
    throw refusal(
      "STOP",
      "DESTINATION_EXISTS",
      "Refusing to overwrite an existing migration directory",
    );
  }
  fs.mkdirSync(destinationRoot, { recursive: false });
  for (const file of verified.files) {
    const target = path.join(destinationRoot, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const handle = fs.openSync(target, "wx");
    try {
      fs.writeFileSync(handle, file.bytes);
    } finally {
      fs.closeSync(handle);
    }
    fs.chmodSync(target, 0o444);
  }
  const materialized = {
    root: destinationRoot,
    schemaPath: path.join(destinationRoot, PINNED_SCHEMA_PRISMA.path),
    digest: verified.digest,
  };
  revalidateMigrationSet(materialized);
  return materialized;
}

export function revalidateMigrationSet(set: MaterializedMigrationSet): void {
  const observed = hashMaterializedRoot(set.root);
  if (observed !== set.digest) {
    throw refusal("STOP", "PREFLIGHT_DRIFT", "Sealed migration directory changed before use");
  }
}

export function hashMaterializedRoot(root: string): string {
  const files: Array<{ path: string; sha256: string }> = [];
  walk(root, root, files);
  return digestOf(files);
}

function walk(root: string, current: string, files: Array<{ path: string; sha256: string }>): void {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (entry.name === ".ambiguous-stop") continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      walk(root, absolute, files);
      continue;
    }
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const sha256 = createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
    files.push({ path: relative, sha256 });
  }
}

function digestOf(files: ReadonlyArray<{ path: string; sha256: string }>): string {
  const lines = [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => `${file.path} ${file.sha256}`)
    .join("\n");
  return createHash("sha256").update(lines).digest("hex");
}
