import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";
import {
  actionPolicy,
  classifiedActionEntries,
} from "./server-action-policy.mjs";

const root = process.cwd();
const srcRoot = path.join(root, "src");
const failures = [];

const entries = classifiedActionEntries();
const categoriesByKey = new Map();
for (const entry of entries) {
  const categories = categoriesByKey.get(entry.key) ?? [];
  categories.push(entry.category);
  categoriesByKey.set(entry.key, categories);
}
for (const [key, categories] of categoriesByKey) {
  if (categories.length !== 1) {
    failures.push(`${key}: classified ${categories.length} times (${categories.join(", ")})`);
  }
}

function walkSourceFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(absolute, acc);
      continue;
    }
    if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      acc.push(absolute);
    }
  }
  return acc;
}

function hasUseServerDirective(sourceFile) {
  return sourceFile.statements.some(
    (statement) =>
      ts.isExpressionStatement(statement) &&
      ts.isStringLiteral(statement.expression) &&
      statement.expression.text === "use server",
  );
}

function isExported(statement) {
  if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) return true;
  return Boolean(statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function isTypeOnlyExport(statement) {
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return true;
  if (ts.isExportDeclaration(statement) && statement.isTypeOnly) return true;
  if (
    ts.isExportDeclaration(statement) &&
    statement.exportClause &&
    ts.isNamedExports(statement.exportClause)
  ) {
    return statement.exportClause.elements.every((element) => element.isTypeOnly);
  }
  return false;
}

function canonicalAsyncExportName(statement) {
  if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) return null;
  const modifiers = statement.modifiers ?? [];
  const exported = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  const async = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
  const isDefault = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
  if (exported && async && !isDefault) return statement.name.text;
  return null;
}

function describeUnsupportedExport(statement) {
  if (ts.isVariableStatement(statement)) {
    const names = statement.declarationList.declarations
      .map((item) => (item.name && ts.isIdentifier(item.name) ? item.name.text : "?"))
      .join(", ");
    return `export const/let ${names}`;
  }
  if (ts.isFunctionDeclaration(statement)) {
    const isDefault = Boolean(
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword),
    );
    if (isDefault) return "export default async function";
    if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
      return `export function ${statement.name?.text ?? "?"}`;
    }
    if (!statement.name) return "anonymous exported function";
    if (!statement.body) return `exported function ${statement.name.text} has no body`;
  }
  if (ts.isExportAssignment(statement)) return "export default";
  if (ts.isExportDeclaration(statement)) {
    if (statement.isTypeOnly) return null;
    if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      const values = statement.exportClause.elements.filter((element) => !element.isTypeOnly);
      if (values.length === 0) return null;
      const names = values
        .map((element) =>
          element.propertyName ? `${element.propertyName.text} as ${element.name.text}` : element.name.text,
        )
        .join(", ");
      return `export { ${names} }`;
    }
    if (!statement.exportClause && statement.moduleSpecifier) return "export *";
  }
  return `exported ${ts.SyntaxKind[statement.kind]}`;
}

function unsupportedExportsIn(sourceText) {
  const sourceFile = ts.createSourceFile(
    "fixture.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return sourceFile.statements
    .filter((statement) => isExported(statement) && !isTypeOnlyExport(statement) && !canonicalAsyncExportName(statement))
    .map(describeUnsupportedExport)
    .filter(Boolean);
}

const failClosedFixtures = [
  ['"use server";\nexport const foo = async () => {};', "export const/let foo"],
  ['"use server";\nexport default async function foo() {}', "export default async function"],
  ['"use server";\nasync function foo() {}\nexport { foo as bar };', "export { foo as bar }"],
];
for (const [sourceText, expected] of failClosedFixtures) {
  const found = unsupportedExportsIn(sourceText);
  if (!found.includes(expected)) {
    failures.push(
      `fail-closed detector missed ${expected} (got: ${found.join(", ") || "none"})`,
    );
  }
}

function isRequireGuardCall(expression, guardName) {
  return (
    ts.isAwaitExpression(expression) &&
    ts.isCallExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === guardName
  );
}

function startsWithGuard(declaration, guardName) {
  const first = declaration.body.statements[0];
  if (!first) return false;
  if (ts.isExpressionStatement(first)) return isRequireGuardCall(first.expression, guardName);
  if (!ts.isVariableStatement(first)) return false;
  return first.declarationList.declarations.some(
    (item) => item.initializer && isRequireGuardCall(item.initializer, guardName),
  );
}

const sourceActions = new Map();
for (const absolute of walkSourceFiles(srcRoot)) {
  const sourceText = fs.readFileSync(absolute, "utf8");
  const sourceFile = ts.createSourceFile(
    absolute,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    absolute.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  if (!hasUseServerDirective(sourceFile)) continue;

  const rel = path.relative(root, absolute).replaceAll("\\", "/");
  const moduleName = path.basename(absolute).replace(/\.(ts|tsx)$/, "");

  for (const statement of sourceFile.statements) {
    if (!isExported(statement) || isTypeOnlyExport(statement)) continue;
    const name = canonicalAsyncExportName(statement);
    if (name) {
      const key = `${moduleName}.${name}`;
      if (sourceActions.has(key)) {
        failures.push(`${key}: duplicate Server Action key (${rel} and ${sourceActions.get(key).file})`);
      }
      sourceActions.set(key, { declaration: statement, file: rel });
      continue;
    }
    const unsupported = describeUnsupportedExport(statement);
    if (unsupported) {
      failures.push(
        `${rel}: unsupported Server Action form: ${unsupported}. ` +
          `Policy is fail-closed — use \`export async function Name\` or move it out of a "use server" module.`,
      );
    }
  }
}

const expectedPublic = new Set(
  Object.entries(actionPolicy)
    .filter(([category]) => category !== "INTERNAL_SERVER")
    .flatMap(([, keys]) => keys),
);
const expectedInternal = new Set(actionPolicy.INTERNAL_SERVER);

for (const [key, action] of sourceActions) {
  const category = categoriesByKey.get(key)?.[0];
  if (!category) {
    failures.push(`${key}: exported from a "use server" module but not classified`);
    continue;
  }
  if (expectedInternal.has(key)) {
    failures.push(`${key}: INTERNAL_SERVER is still exported as a Server Action`);
  }
  if (category === "ADMIN_ACTION" && !startsWithGuard(action.declaration, "requireAdmin")) {
    failures.push(`${key}: first executable statement is not await requireAdmin()`);
  }
  if (
    category === "TERMINAL_ACTION" &&
    !startsWithGuard(action.declaration, "requireTerminalEmployee")
  ) {
    failures.push(`${key}: first executable statement is not await requireTerminalEmployee()`);
  }
  if (key === "terminal.getTerminalData" && action.declaration.parameters.length !== 0) {
    failures.push(`${key}: must derive employee exclusively from terminal session`);
  }
}

for (const key of expectedPublic) {
  if (!sourceActions.has(key)) failures.push(`${key}: classified public action is missing`);
}

if (entries.length !== 125) {
  failures.push(`policy must classify the original 125 exports, got ${entries.length}`);
}

if (failures.length > 0) {
  console.error(`Server Action source policy failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Server Action source policy passed: ${sourceActions.size} public actions; ` +
    `${actionPolicy.ADMIN_ACTION.length} admin, ${actionPolicy.TERMINAL_ACTION.length} terminal, ` +
    `${actionPolicy.AUTH_ACTION.length} auth; scanned ${walkSourceFiles(srcRoot).length} source files.`,
);
