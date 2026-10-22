/**
 * Canonical PostgreSQL 17 column and constraint fingerprints.
 *
 * attnum is not part of a column. A plain restore closes holes left by
 * dropped columns, so ordinal_position changes while the logical column
 * does not. CHECK text keeps parentheses only where precedence needs them.
 * AND with AND, and OR with OR, are flattened. AND inside OR is not.
 * OID, business rows, and constraint definition bytes are not the digest.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const UNIT = "\u001f";

export const COLUMN_SQL = `
SELECT n.nspname,
       c.relname,
       a.attname,
       pg_catalog.format_type(a.atttypid, a.atttypmod),
       CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END,
       CASE WHEN ad.adbin IS NULL THEN '0' ELSE '1' END,
       CASE WHEN ad.adbin IS NULL THEN '' ELSE pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) END,
       CASE WHEN a.attidentity = '' THEN '0' ELSE '1' END,
       a.attidentity,
       CASE WHEN a.attgenerated = '' THEN '0' ELSE '1' END,
       a.attgenerated,
       CASE WHEN a.attcollation = 0 THEN '0' ELSE '1' END,
       CASE WHEN a.attcollation = 0 THEN '' ELSE col.collname END
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
LEFT JOIN pg_catalog.pg_collation col ON col.oid = a.attcollation
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND NOT c.relispartition
  AND a.attnum > 0
  AND NOT a.attisdropped
ORDER BY n.nspname, c.relname, a.attname
`.trim();

export const CONSTRAINT_SQL = `
SELECT n.nspname,
       c.relname,
       con.conname,
       con.contype::text,
       CASE WHEN con.convalidated THEN 'validated' ELSE 'not-validated' END,
       CASE WHEN con.condeferrable THEN 'deferrable' ELSE 'not-deferrable' END,
       CASE WHEN con.condeferred THEN 'initially-deferred' ELSE 'not-initially-deferred' END,
       pg_catalog.pg_get_constraintdef(con.oid)
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND NOT c.relispartition
ORDER BY n.nspname, c.relname, con.conname
`.trim();

const PRECEDENCE = {
  or: 1,
  and: 2,
  not: 3,
  cmp: 4,
  add: 5,
  mul: 6,
  unary: 7,
  cast: 8,
  primary: 9,
};

const KEYWORDS = new Set([
  "AND",
  "OR",
  "NOT",
  "IS",
  "NULL",
  "ANY",
  "ARRAY",
  "CHECK",
  "IN",
  "BETWEEN",
  "LIKE",
  "ILIKE",
]);

const COMPARISONS = new Set(["=", "<>", "!=", "<", ">", "<=", ">="]);

export class FingerprintSyntaxError extends Error {
  constructor(message) {
    super(message);
    this.name = "FingerprintSyntaxError";
  }
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function digest(lines) {
  const body = lines.length === 0 ? "" : `${[...lines].sort().join("\n")}\n`;
  return sha256(body);
}

function escapeField(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\n", "\\n").replaceAll("\r", "\\r");
}

export function columnFingerprint(psqlText) {
  const lines = [];
  for (const raw of psqlText.split(/\n/)) {
    if (raw.length === 0) continue;
    const field = raw.split(UNIT);
    if (field.length !== 13) {
      throw new FingerprintSyntaxError("column fingerprint row is not 13 fields");
    }
    const [
      schema,
      table,
      column,
      type,
      nullable,
      hasDefault,
      columnDefault,
      hasIdentity,
      identity,
      hasGenerated,
      generated,
      hasCollation,
      collation,
    ] = field;
    lines.push(
      [
        escapeField(schema),
        escapeField(table),
        escapeField(column),
        escapeField(type),
        nullable,
        hasDefault === "1" ? `default=${escapeField(columnDefault)}` : "default=\\N",
        hasIdentity === "1" ? `identity=${escapeField(identity)}` : "identity=\\N",
        hasGenerated === "1" ? `generated=${escapeField(generated)}` : "generated=\\N",
        hasCollation === "1" ? `collation=${escapeField(collation)}` : "collation=\\N",
      ].join("|"),
    );
  }
  return digest(lines);
}

export function constraintFingerprint(psqlText) {
  const lines = [];
  for (const raw of psqlText.split(/\n/)) {
    if (raw.length === 0) continue;
    const field = raw.split(UNIT);
    if (field.length !== 8) {
      throw new FingerprintSyntaxError("constraint fingerprint row is not 8 fields");
    }
    const [schema, table, name, type, validated, deferrable, initiallyDeferred, definition] = field;
    lines.push(
      [
        escapeField(schema),
        escapeField(table),
        escapeField(name),
        type,
        validated,
        deferrable,
        initiallyDeferred,
        escapeField(canonicalizeConstraintDefinition(definition)),
      ].join("|"),
    );
  }
  return digest(lines);
}

export function collapseWhitespace(definition) {
  let out = "";
  let quote = "";
  for (let index = 0; index < definition.length; index += 1) {
    const char = definition[index] ?? "";
    if (quote) {
      out += char;
      if (char === quote) {
        if (definition[index + 1] === quote) {
          out += quote;
          index += 1;
          continue;
        }
        quote = "";
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      out += char;
      continue;
    }
    if (/\s/.test(char)) {
      if (!out.endsWith(" ")) out += " ";
      continue;
    }
    out += char;
  }
  if (quote) throw new FingerprintSyntaxError("constraint definition has an open quote");
  return out.trim();
}

export function canonicalizeConstraintDefinition(definition) {
  const collapsed = collapseWhitespace(definition);
  if (!/^CHECK\b/i.test(collapsed)) return collapsed;
  const tokens = tokenize(collapsed);
  const parser = new Parser(tokens);
  parser.expectKeyword("CHECK");
  parser.expectPunct("(");
  const expression = parser.parseOr();
  parser.expectPunct(")");
  if (parser.accept("keyword", "NOT")) parser.expectKeyword("VALID");
  parser.expectEnd();
  return `CHECK (${expression.text})`;
}

function tokenize(input) {
  const tokens = [];
  let index = 0;
  const two = (value) => input.startsWith(value, index);
  while (index < input.length) {
    const char = input[index] ?? "";
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      const quote = char;
      let end = index + 1;
      let text = quote;
      while (end < input.length) {
        const next = input[end] ?? "";
        text += next;
        if (next === quote) {
          if (input[end + 1] === quote) {
            text += quote;
            end += 2;
            continue;
          }
          end += 1;
          break;
        }
        end += 1;
      }
      if (!text.endsWith(quote) || text.length < 2) {
        throw new FingerprintSyntaxError("constraint definition has an open quote");
      }
      tokens.push({ kind: quote === "'" ? "string" : "ident", text });
      index = end;
      continue;
    }
    if (two("::") || two("<>") || two("!=") || two("<=") || two(">=")) {
      tokens.push({ kind: "op", text: input.slice(index, index + 2) });
      index += 2;
      continue;
    }
    if ("()[],".includes(char)) {
      tokens.push({ kind: "punct", text: char });
      index += 1;
      continue;
    }
    if (/[0-9]/.test(char)) {
      let end = index + 1;
      while (end < input.length && /[0-9.]/.test(input[end] ?? "")) end += 1;
      tokens.push({ kind: "number", text: input.slice(index, end) });
      index = end;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < input.length && /[A-Za-z0-9_]/.test(input[end] ?? "")) end += 1;
      const text = input.slice(index, end);
      const upper = text.toUpperCase();
      tokens.push({ kind: KEYWORDS.has(upper) ? "keyword" : "ident", text: KEYWORDS.has(upper) ? upper : text });
      index = end;
      continue;
    }
    if ("=<>+-*/%".includes(char)) {
      tokens.push({ kind: "op", text: char });
      index += 1;
      continue;
    }
    throw new FingerprintSyntaxError(`unexpected constraint character ${char}`);
  }
  return tokens;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.index = 0;
  }

  peek() {
    return this.tokens[this.index];
  }

  accept(kind, text) {
    const token = this.peek();
    if (!token || token.kind !== kind || (text !== undefined && token.text !== text)) return null;
    this.index += 1;
    return token;
  }

  expectPunct(text) {
    if (!this.accept("punct", text)) throw new FingerprintSyntaxError(`expected ${text}`);
  }

  expectKeyword(text) {
    if (!this.accept("keyword", text)) throw new FingerprintSyntaxError(`expected ${text}`);
  }

  expectEnd() {
    if (this.peek()) throw new FingerprintSyntaxError("unexpected trailing constraint text");
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.accept("keyword", "OR")) {
      const right = this.parseAnd();
      left = {
        prec: PRECEDENCE.or,
        text: `${wrap(left, PRECEDENCE.or, false)} OR ${wrap(right, PRECEDENCE.or, false)}`,
      };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseNot();
    while (this.accept("keyword", "AND")) {
      const right = this.parseNot();
      left = {
        prec: PRECEDENCE.and,
        text: `${wrap(left, PRECEDENCE.and, false)} AND ${wrap(right, PRECEDENCE.and, false)}`,
      };
    }
    return left;
  }

  parseNot() {
    if (!this.accept("keyword", "NOT")) return this.parseComparison();
    const operand = this.parseNot();
    return { prec: PRECEDENCE.not, text: `NOT ${wrap(operand, PRECEDENCE.not, false)}` };
  }

  parseComparison() {
    const left = this.parseSum();
    if (this.accept("keyword", "IS")) {
      const negated = this.accept("keyword", "NOT");
      this.expectKeyword("NULL");
      return {
        prec: PRECEDENCE.cmp,
        text: `${wrap(left, PRECEDENCE.cmp, false)} IS ${negated ? "NOT " : ""}NULL`,
      };
    }
    const operator = this.peek();
    if (!operator || operator.kind !== "op" || !COMPARISONS.has(operator.text)) return left;
    this.index += 1;
    if (this.accept("keyword", "ANY") || this.accept("keyword", "IN")) {
      const form = this.tokens[this.index - 1]?.text;
      this.expectPunct("(");
      const inner = this.parseAnyInner();
      this.expectPunct(")");
      return {
        prec: PRECEDENCE.cmp,
        text: `${wrap(left, PRECEDENCE.cmp, false)} ${operator.text} ${form} (${inner})`,
      };
    }
    const right = this.parseSum();
    return {
      prec: PRECEDENCE.cmp,
      text: `${wrap(left, PRECEDENCE.cmp, false)} ${operator.text} ${wrap(right, PRECEDENCE.cmp, false)}`,
    };
  }

  parseAnyInner() {
    if (this.accept("keyword", "ARRAY")) {
      this.expectPunct("[");
      const items = [];
      if (!this.accept("punct", "]")) {
        items.push(this.parseOr().text);
        while (this.accept("punct", ",")) items.push(this.parseOr().text);
        this.expectPunct("]");
      }
      return `ARRAY[${items.join(", ")}]`;
    }
    return this.parseOr().text;
  }

  parseSum() {
    let left = this.parseProduct();
    for (;;) {
      const operator = this.accept("op", "+") ?? this.accept("op", "-");
      if (!operator) return left;
      const right = this.parseProduct();
      const wrapRight = operator.text === "-";
      left = {
        prec: PRECEDENCE.add,
        text: `${wrap(left, PRECEDENCE.add, false)} ${operator.text} ${wrap(right, PRECEDENCE.add, wrapRight)}`,
      };
    }
  }

  parseProduct() {
    let left = this.parseUnary();
    for (;;) {
      const operator = this.accept("op", "*") ?? this.accept("op", "/") ?? this.accept("op", "%");
      if (!operator) return left;
      const right = this.parseUnary();
      const wrapRight = operator.text !== "*";
      left = {
        prec: PRECEDENCE.mul,
        text: `${wrap(left, PRECEDENCE.mul, false)} ${operator.text} ${wrap(right, PRECEDENCE.mul, wrapRight)}`,
      };
    }
  }

  parseUnary() {
    const operator = this.accept("op", "+") ?? this.accept("op", "-");
    if (!operator) return this.parseCast();
    const operand = this.parseUnary();
    return { prec: PRECEDENCE.unary, text: `${operator.text}${wrap(operand, PRECEDENCE.unary, false)}` };
  }

  parseCast() {
    let left = this.parsePrimary();
    while (this.accept("op", "::")) {
      const typeName = this.parseTypeName();
      left = { prec: PRECEDENCE.cast, text: `${wrap(left, PRECEDENCE.cast, false)}::${typeName}` };
    }
    return left;
  }

  parseTypeName() {
    const token = this.peek();
    if (!token || token.kind !== "ident") throw new FingerprintSyntaxError("expected a cast type");
    this.index += 1;
    if (!this.accept("punct", "(")) return token.text;
    const args = [];
    if (!this.accept("punct", ")")) {
      args.push(this.parseOr().text);
      while (this.accept("punct", ",")) args.push(this.parseOr().text);
      this.expectPunct(")");
    }
    return `${token.text}(${args.join(", ")})`;
  }

  parsePrimary() {
    if (this.accept("punct", "(")) {
      const inner = this.parseOr();
      this.expectPunct(")");
      return inner;
    }
    if (this.accept("keyword", "ARRAY")) {
      this.expectPunct("[");
      const items = [];
      if (!this.accept("punct", "]")) {
        items.push(this.parseOr().text);
        while (this.accept("punct", ",")) items.push(this.parseOr().text);
        this.expectPunct("]");
      }
      return { prec: PRECEDENCE.primary, text: `ARRAY[${items.join(", ")}]` };
    }
    if (this.accept("keyword", "NULL")) return { prec: PRECEDENCE.primary, text: "NULL" };
    const ident = this.accept("ident");
    if (ident) {
      if (!this.accept("punct", "(")) return { prec: PRECEDENCE.primary, text: ident.text };
      const args = [];
      if (!this.accept("punct", ")")) {
        args.push(this.parseOr().text);
        while (this.accept("punct", ",")) args.push(this.parseOr().text);
        this.expectPunct(")");
      }
      return { prec: PRECEDENCE.primary, text: `${ident.text}(${args.join(", ")})` };
    }
    const literal = this.accept("string") ?? this.accept("number");
    if (literal) return { prec: PRECEDENCE.primary, text: literal.text };
    throw new FingerprintSyntaxError("expected a constraint expression");
  }
}

function wrap(node, parentPrecedence, wrapEqual) {
  if (node.prec > parentPrecedence) return node.text;
  if (node.prec === parentPrecedence && !wrapEqual) return node.text;
  return `(${node.text})`;
}

function fingerprintsFromStream(text) {
  const marker = "\u001e";
  const splitAt = text.indexOf(marker);
  if (splitAt < 0) throw new FingerprintSyntaxError("fingerprint input is missing");
  return {
    columns: columnFingerprint(text.slice(0, splitAt)),
    constraints: constraintFingerprint(text.slice(splitAt + marker.length)),
  };
}

function main() {
  const [first] = process.argv.slice(2);
  if (first === "--print-column-sql") {
    process.stdout.write(`${COLUMN_SQL}\n`);
    return;
  }
  if (first === "--print-constraint-sql") {
    process.stdout.write(`${CONSTRAINT_SQL}\n`);
    return;
  }
  if (first !== "--stdin") throw new FingerprintSyntaxError("fingerprint input is missing");
  const fingerprinted = fingerprintsFromStream(readFileSync(0, "utf8"));
  process.stdout.write(
    `column_fingerprint=${fingerprinted.columns}\nconstraint_fingerprint=${fingerprinted.constraints}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch {
    process.stderr.write("FingerprintSyntaxError\n");
    process.exit(2);
  }
}
