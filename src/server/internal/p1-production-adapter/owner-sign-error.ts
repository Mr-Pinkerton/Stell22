export class OwnerSignError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "OwnerSignError";
    this.code = code;
  }
}
