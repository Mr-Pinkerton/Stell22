import { spawnSync } from "node:child_process";
import path from "node:path";
import { OwnerSignError } from "@/server/internal/p1-production-adapter/owner-sign-error";

/**
 * Read-only check, plus a restrict step used for a file this process just created
 * or for a disposable directory a test already owns.
 * The Owner key file is never passed to the restrict step.
 * Set-Acl names a path. It is not an atomic update of the creating handle.
 * A failed PowerShell call is ACL_UNVERIFIED. A readable but open ACL is rejected.
 */

const READ_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$path = $env:STELL22_ACL_PATH
$acl = Get-Acl -LiteralPath $path
@($acl.Access) | ForEach-Object {
  '{0}|{1}|{2}|{3}' -f $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value, $_.FileSystemRights, $_.AccessControlType, $_.IsInherited
}
`;

const RESTRICT_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$path = $env:STELL22_ACL_PATH
$sid = New-Object System.Security.Principal.SecurityIdentifier($env:STELL22_ACL_SID)
$acl = Get-Acl -LiteralPath $path
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRule($rule) }
$inherit = if ($env:STELL22_ACL_KIND -eq 'dir') {
  [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
} else {
  [System.Security.AccessControl.InheritanceFlags]::None
}
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
  $sid,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  $inherit,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $path -AclObject $acl
`;

export type AclEntry = { sid: string; rights: string; access: string; inherited: boolean };

export function currentUserSid(): string {
  if (process.platform !== "win32") throw new OwnerSignError("ACL_UNVERIFIED");
  const result = spawnSync(systemBinary("whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
    env: minimalEnv(),
  });
  const sid = (result.stdout || "").split(",").pop()?.trim().replaceAll('"', "") ?? "";
  if (result.status !== 0 || !/^S-1-[0-9-]+$/.test(sid)) throw new OwnerSignError("ACL_UNVERIFIED");
  return sid;
}

export function readAclEntries(target: string): AclEntry[] {
  const stdout = powershell(READ_SCRIPT, target, null, null);
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.map((line) => {
    const [sid, rights, access, inherited] = line.split("|");
    if (!sid || !rights || !access || (inherited !== "True" && inherited !== "False")) {
      throw new OwnerSignError("ACL_UNVERIFIED");
    }
    return { sid, rights, access, inherited: inherited === "True" };
  });
}

export function assertSingleUserAcl(target: string, sid: string, rejectionCode = "KEY_PERMISSIONS_REJECTED"): void {
  let entries: AclEntry[];
  try {
    entries = readAclEntries(target);
  } catch (error) {
    if (error instanceof OwnerSignError) throw error;
    throw new OwnerSignError("ACL_UNVERIFIED");
  }
  const entry = entries.length === 1 ? entries[0] : null;
  if (!entry || entry.sid !== sid || entry.rights !== "FullControl" || entry.access !== "Allow" || entry.inherited) {
    throw new OwnerSignError(rejectionCode);
  }
}

export function restrictSingleUser(target: string, kind: "file" | "dir", sid: string, rejectionCode = "KEY_PERMISSIONS_REJECTED"): void {
  powershell(RESTRICT_SCRIPT, target, sid, kind);
  assertSingleUserAcl(target, sid, rejectionCode);
}

function powershell(script: string, target: string, sid: string | null, kind: "file" | "dir" | null): string {
  if (process.platform !== "win32") throw new OwnerSignError("ACL_UNVERIFIED");
  const result = spawnSync(systemBinary(path.join("WindowsPowerShell", "v1.0", "powershell.exe")), ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...minimalEnv(),
      STELL22_ACL_PATH: target,
      ...(sid ? { STELL22_ACL_SID: sid } : {}),
      ...(kind ? { STELL22_ACL_KIND: kind } : {}),
    },
  });
  if (result.status !== 0) throw new OwnerSignError("ACL_UNVERIFIED");
  return result.stdout || "";
}

function systemBinary(name: string): string {
  const root = process.env.SystemRoot;
  if (!root) throw new OwnerSignError("ACL_UNVERIFIED");
  return path.join(root, "System32", name);
}

function minimalEnv(): NodeJS.ProcessEnv {
  const root = process.env.SystemRoot;
  if (!root) throw new OwnerSignError("ACL_UNVERIFIED");
  return {
    NODE_ENV: process.env.NODE_ENV ?? "production",
    SystemRoot: root,
    WINDIR: process.env.WINDIR ?? root,
    PATH: path.join(root, "System32"),
    PATHEXT: ".EXE",
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
  };
}
