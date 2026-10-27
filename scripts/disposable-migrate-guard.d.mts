export class DisposableMigrateRefusal extends Error {
  code: string;
  constructor(code: string, message: string);
}

export function parseDisposableDatabaseUrl(raw: string | undefined): {
  database: string;
  port: number;
  host: string;
  href: string;
};

export function assertOutsideRepository(candidate: string, repositoryRoot: string): void;
