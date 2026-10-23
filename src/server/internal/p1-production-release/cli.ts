/**
 * The TypeScript entry stays locked.
 * The production command is scripts/release-role-split.sh.
 * A phrase in the environment does not open a database from this module.
 */

export function runReleaseCli(argv: readonly string[]): number {
  void argv;
  process.stdout.write("RESULT=STOP_LOCKED\nPRODUCTION_RELEASE=NO-GO\nDATABASE_RESTORE=NO\n");
  return 1;
}
