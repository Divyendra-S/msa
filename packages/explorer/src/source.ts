import { readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

/** What a piece of server code does, in source order. */
export type Effect =
  | SqlEffect
  | FetchEffect
  | { kind: "tx"; effects: Effect[] }
  | {
      kind: "call";
      name: string;
      file: string;
      auth: boolean;
      /** The call site passes something named like an idempotency key. */
      keyArg: boolean;
      effects: Effect[];
    };

export interface FetchEffect {
  kind: "fetch";
  method: string;
  url: string;
  /** `always`: the request itself carries an idempotency key · `optional`: only when a caller passes one. */
  idempotencyKey: "always" | "optional" | "none";
}

export interface SqlEffect {
  kind: "sql";
  op: "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "UPSERT";
  tables: string[];
  /** Compact statement, e.g. `UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1`. */
  text: string;
  where?: string;
  /** UPDATE/DELETE whose WHERE checks more than the row key (state, version, stock…). */
  guarded?: boolean;
  onConflict?: boolean;
  forUpdate?: boolean;
}

export interface UiFacts {
  buttons: string[];
  /** Short texts the page can show (status lines, messages): what a flow waits for. */
  texts: string[];
  links: { text: string; href: string }[];
  fields: string[];
  requests: { method: string; url: string }[];
  redirects: string[];
}

interface ParsedFile {
  file: string;
  sf: ts.SourceFile;
  /** local name → module file (resolved) + exported name */
  imports: Map<string, { file: string; name: string }>;
  functions: Map<string, ts.FunctionLikeDeclaration>;
  /** Local files it loads at runtime: imports, re-exports, import(), require(); styles and data too. */
  deps: string[];
}

/**
 * Called helpers whose names look like authentication or signature checks: `getCurrentUser`,
 * `requireUser`, `getServerSession`, `verifyWebhookSignature`, `login`, `auth.api.getSession`
 * (but not `getUserCart`).
 */
export const AUTH_NAME = /(^|\.)(auth|authenticate|authorize|login|logout|sign_?in|sign_?out)\b|(user|session|auth|signature|token|permissions?|roles?)$/i;
const MAX_DEPTH = 3;
const SQL_START = /^\s*(WITH\b[\s\S]*?\)\s*)?(SELECT\b[\s\S]+\bFROM\b|INSERT\s+INTO\s|UPDATE\s+[\w."]+\s+(\w+\s+)?SET\s|DELETE\s+FROM\s)/i;
const PRISMA_OPS: Record<string, SqlEffect["op"]> = {
  findUnique: "SELECT",
  findUniqueOrThrow: "SELECT",
  findFirst: "SELECT",
  findFirstOrThrow: "SELECT",
  findMany: "SELECT",
  count: "SELECT",
  create: "INSERT",
  createMany: "INSERT",
  update: "UPDATE",
  updateMany: "UPDATE",
  upsert: "UPSERT",
  delete: "DELETE",
  deleteMany: "DELETE",
};

/** Parses and caches source files and follows local imports (relative and tsconfig `paths`). */
export class SourceIndex {
  readonly root: string;
  private readonly files = new Map<string, Promise<ParsedFile | undefined>>();
  private paths?: Promise<{ base: string; map: [string, string[]][] }>;

  constructor(root: string) {
    this.root = root;
  }

  rel(file: string): string {
    return relative(this.root, file);
  }

  parse(file: string): Promise<ParsedFile | undefined> {
    let parsed = this.files.get(file);
    if (!parsed) {
      parsed = this.load(file);
      this.files.set(file, parsed);
    }
    return parsed;
  }

  /** Effects of each exported function named in `names` (e.g. HTTP methods), or the default export. */
  async handlers(file: string, names: string[]): Promise<{ name: string; effects: Effect[]; comment?: string }[]> {
    const parsed = await this.parse(file);
    if (!parsed) return [];
    const out: { name: string; effects: Effect[]; comment?: string }[] = [];
    for (const name of names) {
      const fn = parsed.functions.get(name);
      if (!fn || !isExported(fn, parsed.sf, name)) continue;
      const comment = leadingComment(fn, parsed.sf);
      out.push({ name, effects: await this.analyze(parsed, fn, 0, new Set()), ...(comment ? { comment } : {}) });
    }
    return out;
  }

  /** Local files a module loads at runtime (not `import type`). */
  async dependencies(file: string): Promise<string[]> {
    return (await this.parse(file))?.deps ?? [];
  }

  /** Exported HTTP method handlers of a Next.js route file. */
  async exportedNames(file: string): Promise<string[]> {
    const parsed = await this.parse(file);
    if (!parsed) return [];
    return [...parsed.functions.keys()].filter((n) => isExported(parsed.functions.get(n)!, parsed.sf, n));
  }

  /** Buttons, links, form fields and fetch calls in a component file and the local components it renders. */
  async ui(file: string, depth = 0, seen = new Set<string>()): Promise<{ facts: UiFacts; components: string[] }> {
    const facts: UiFacts = { buttons: [], texts: [], links: [], fields: [], requests: [], redirects: [] };
    const components: string[] = [];
    const parsed = await this.parse(file);
    if (!parsed || seen.has(file)) return { facts, components };
    seen.add(file);
    const visit = (node: ts.Node): void => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        const tag = opening.tagName.getText(parsed.sf);
        const attr = (name: string) => jsxAttr(opening, name, parsed.sf);
        if (tag === "button") facts.buttons.push(ts.isJsxElement(node) ? jsxText(node, parsed.sf) : (attr("aria-label") ?? ""));
        else if ((tag === "Link" || tag === "a") && attr("href")) {
          facts.links.push({ text: ts.isJsxElement(node) ? jsxText(node, parsed.sf) : "", href: attr("href")! });
        } else if (tag === "label" && ts.isJsxElement(node)) {
          const text = node.children.find(ts.isJsxText)?.getText(parsed.sf).trim();
          if (text) facts.fields.push(text);
        } else if (/^[A-Z]/.test(tag) && parsed.imports.has(tag)) {
          components.push(tag);
        } else if (/^(p|span|h[1-6]|strong|em|small|li|td)$/.test(tag) && ts.isJsxElement(node)) {
          const text = jsxText(node, parsed.sf);
          if (text && text.length <= 100 && /[a-z]/i.test(text)) facts.texts.push(text);
        }
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(parsed.sf);
        if (callee === "fetch") {
          const req = fetchCall(node, parsed.sf);
          facts.requests.push({ method: req.method, url: req.url });
        } else if (callee === "redirect" && depth === 0 && node.arguments[0]) {
          // Server-side redirects in the page itself gate it (e.g. to the login page).
          facts.redirects.push(literalText(node.arguments[0], parsed.sf));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed.sf);
    facts.buttons = unique(facts.buttons.filter(Boolean));
    facts.texts = unique(facts.texts).filter((t) => !facts.buttons.includes(t));
    facts.fields = unique(facts.fields);
    if (depth < 2) {
      for (const name of unique(components)) {
        const target = parsed.imports.get(name)!;
        const child = await this.ui(target.file, depth + 1, seen);
        mergeUi(facts, child.facts);
      }
    }
    return { facts, components: unique(components) };
  }

  private async load(file: string): Promise<ParsedFile | undefined> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return undefined;
    }
    const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.jsx?$/.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
    const imports = new Map<string, { file: string; name: string }>();
    const functions = new Map<string, ts.FunctionLikeDeclaration>();
    const deps = new Set<string>();
    const specs: string[] = [];
    const findLoads = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) {
        specs.push(node.moduleSpecifier.text);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) {
        specs.push(node.moduleSpecifier.text);
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        specs.push(node.arguments[0].text);
      }
      ts.forEachChild(node, findLoads);
    };
    findLoads(sf);
    for (const spec of specs) {
      const target = (await this.resolveModule(file, spec)) ?? (await this.resolveAsset(file, spec));
      if (target) deps.add(target);
    }
    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier) && stmt.importClause) {
        const target = await this.resolveModule(file, stmt.moduleSpecifier.text);
        if (!target) continue;
        const clause = stmt.importClause;
        if (clause.name) imports.set(clause.name.text, { file: target, name: "default" });
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            imports.set(el.name.text, { file: target, name: (el.propertyName ?? el.name).text });
          }
        }
      } else if (ts.isFunctionDeclaration(stmt) && stmt.body) {
        const isDefault = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
        if (stmt.name) functions.set(stmt.name.text, stmt);
        if (isDefault) functions.set("default", stmt);
      } else if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          const init = decl.initializer;
          if (ts.isIdentifier(decl.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
            functions.set(decl.name.text, init);
          }
        }
      } else if (ts.isExportAssignment(stmt)) {
        const expr = stmt.expression;
        if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) functions.set("default", expr);
      }
    }
    return { file, sf, imports, functions, deps: [...deps] };
  }

  private async analyze(
    parsed: ParsedFile,
    fn: ts.FunctionLikeDeclaration,
    depth: number,
    stack: Set<ts.Node>,
  ): Promise<Effect[]> {
    if (!fn.body || stack.has(fn)) return [];
    stack.add(fn);
    const out: Effect[] = [];
    const fnText = fn.getText(parsed.sf);
    await this.walk(parsed, fn.body, out, depth, stack, fnText);
    stack.delete(fn);
    return out;
  }

  private async walk(
    parsed: ParsedFile,
    node: ts.Node,
    out: Effect[],
    depth: number,
    stack: Set<ts.Node>,
    fnText: string,
  ): Promise<void> {
    const { sf } = parsed;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const sql = parseSql(literalText(node, sf));
      if (sql) out.push(sql);
      return;
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : "";

      if (name === "fetch") {
        const req = fetchCall(node, sf);
        const own = node.arguments.slice(1).map((a) => a.getText(sf)).join(",");
        const idempotencyKey = /idempot/i.test(own) ? "always" : /idempot/i.test(fnText) ? "optional" : "none";
        out.push({ kind: "fetch", method: req.method, url: req.url, idempotencyKey });
        return;
      }

      // Prisma: prisma.order.create(...), tx.product.update(...)
      if (ts.isPropertyAccessExpression(callee) && PRISMA_OPS[name] && ts.isPropertyAccessExpression(callee.expression)) {
        const table = callee.expression.name.text;
        const op = PRISMA_OPS[name]!;
        const args = node.arguments[0]?.getText(sf) ?? "";
        const where = /where\s*:\s*\{([^}]*)\}/.exec(args)?.[1]?.replace(/\s+/g, " ").trim();
        out.push({
          kind: "sql",
          op,
          tables: [table],
          text: `${table}.${name}(${where ? `where ${where}` : ""})`,
          ...(where ? { where } : {}),
          ...(op === "UPDATE" || op === "DELETE" ? { guarded: !!where && !isKeyOnly(where.split(",")) } : {}),
          ...(op === "UPSERT" ? { onConflict: true } : {}),
        });
        for (const arg of node.arguments) await this.walk(parsed, arg, out, depth, stack, fnText);
        return;
      }

      // Drizzle: db.insert(table), db.update(table), db.delete(table), db.select().from(table)
      if (
        ts.isPropertyAccessExpression(callee) &&
        /^(insert|update|delete|from)$/.test(name) &&
        node.arguments.length === 1 &&
        ts.isIdentifier(node.arguments[0]!) &&
        /^(db|tx|trx|database|drizzle)$/i.test(chainRoot(callee.expression))
      ) {
        const table = node.arguments[0].text;
        const op = ({ insert: "INSERT", update: "UPDATE", delete: "DELETE", from: "SELECT" } as const)[name as "insert"];
        const chain = node.parent?.parent?.getText(sf) ?? "";
        out.push({ kind: "sql", op, tables: [table], text: `${name}(${table})`, onConflict: /onConflict/.test(chain) });
        await this.walk(parsed, callee.expression, out, depth, stack, fnText);
        return;
      }

      const target = ts.isIdentifier(callee) ? await this.resolveFunction(parsed, callee.text) : undefined;
      const isTx = name === "transaction" || name === "$transaction" || name === "begin" || (target && /\bBEGIN\b/.test(target.fn.getText(target.parsed.sf)));
      if (isTx) {
        const inner: Effect[] = [];
        for (const arg of node.arguments) await this.walk(parsed, arg, inner, depth, stack, fnText);
        out.push({ kind: "tx", effects: inner });
        return;
      }

      // Arguments first (`query("UPDATE …", [...])`), then what the called helper itself does.
      for (const arg of node.arguments) await this.walk(parsed, arg, out, depth, stack, fnText);
      await this.walk(parsed, callee, out, depth, stack, fnText);
      if (target && depth < MAX_DEPTH) {
        const effects = await this.analyze(target.parsed, target.fn, depth + 1, stack);
        const auth = AUTH_NAME.test(callee.getText(sf));
        const keyArg = /idempot/i.test(node.arguments.map((a) => a.getText(sf)).join(","));
        if (effects.length > 0 || auth) {
          out.push({ kind: "call", name: callee.getText(sf), file: this.rel(target.parsed.file), auth, keyArg, effects });
        }
      }
      return;
    }
    for (const child of node.getChildren(sf)) await this.walk(parsed, child, out, depth, stack, fnText);
  }

  private async resolveFunction(
    parsed: ParsedFile,
    name: string,
  ): Promise<{ parsed: ParsedFile; fn: ts.FunctionLikeDeclaration } | undefined> {
    const local = parsed.functions.get(name);
    if (local) return { parsed, fn: local };
    const imported = parsed.imports.get(name);
    if (!imported) return undefined;
    const target = await this.parse(imported.file);
    const fn = target?.functions.get(imported.name);
    return target && fn ? { parsed: target, fn } : undefined;
  }

  /** `./globals.css`, `@/data/x.json`: a local file named with its extension. */
  private async resolveAsset(from: string, spec: string): Promise<string | undefined> {
    if (!/\.[a-z0-9]+$/i.test(spec)) return undefined;
    const base = await this.specBase(from, spec);
    return base && (await stat(base).then((s) => s.isFile(), () => false)) ? base : undefined;
  }

  private async resolveModule(from: string, spec: string): Promise<string | undefined> {
    const base = await this.specBase(from, spec);
    if (!base) return undefined;
    for (const candidate of [base, ...[".ts", ".tsx", ".js", ".jsx", ".mjs"].map((e) => base + e), ...["index.ts", "index.tsx", "index.js"].map((f) => join(base, f))]) {
      if (/\.(m?[jt]sx?)$/.test(candidate) && (await readFile(candidate, "utf8").then(() => true, () => false))) return candidate;
    }
    return undefined;
  }

  /** The path a relative or tsconfig `paths` specifier points at (before extensions); undefined for packages. */
  private async specBase(from: string, spec: string): Promise<string | undefined> {
    let base: string | undefined;
    if (spec.startsWith(".")) base = resolve(dirname(from), spec);
    else {
      const { base: pathsBase, map } = await this.tsPaths();
      for (const [pattern, targets] of map) {
        const prefix = pattern.replace(/\*$/, "");
        if (pattern.endsWith("*") ? spec.startsWith(prefix) : spec === pattern) {
          const rest = spec.slice(prefix.length);
          base = resolve(pathsBase, targets[0]!.replace(/\*$/, rest));
          break;
        }
      }
    }
    return base;
  }

  private tsPaths(): Promise<{ base: string; map: [string, string[]][] }> {
    this.paths ??= (async () => {
      for (const name of ["tsconfig.json", "jsconfig.json"]) {
        const text = await readFile(join(this.root, name), "utf8").catch(() => undefined);
        if (!text) continue;
        const { config } = ts.parseConfigFileTextToJson(name, text);
        const options = (config?.compilerOptions ?? {}) as { baseUrl?: string; paths?: Record<string, string[]> };
        return { base: resolve(this.root, options.baseUrl ?? "."), map: Object.entries(options.paths ?? {}) };
      }
      return { base: this.root, map: [] };
    })();
    return this.paths;
  }
}

function isExported(fn: ts.FunctionLikeDeclaration, sf: ts.SourceFile, name: string): boolean {
  if (name === "default") return true;
  const holder = ts.isFunctionDeclaration(fn) ? fn : fn.parent?.parent?.parent;
  const exported = !!holder && ts.canHaveModifiers(holder) && !!ts.getModifiers(holder)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  if (exported) return true;
  // export { POST } at the bottom of the file
  return sf.statements.some(
    (s) => ts.isExportDeclaration(s) && !!s.exportClause && ts.isNamedExports(s.exportClause) && s.exportClause.elements.some((e) => e.name.text === name),
  );
}

/** First line of the comment right above a function (or its `export const`), if any. */
function leadingComment(fn: ts.FunctionLikeDeclaration, sf: ts.SourceFile): string | undefined {
  const holder = ts.isFunctionDeclaration(fn) ? fn : (fn.parent?.parent?.parent ?? fn);
  const ranges = ts.getLeadingCommentRanges(sf.text, holder.getFullStart()) ?? [];
  const last = ranges.at(-1);
  if (!last) return undefined;
  const text = sf.text
    .slice(last.pos, last.end)
    .replace(/^\/\*\*?|\*\/$/g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*(\/\/|\*)\s?/, "").trim())
    .find(Boolean);
  return text ? (text.length > 100 ? `${text.slice(0, 99)}…` : text) : undefined;
}

/** Root identifier of `a.b().c`, e.g. `db`. */
function chainRoot(node: ts.Expression): string {
  let n: ts.Expression = node;
  while (ts.isPropertyAccessExpression(n) || ts.isCallExpression(n)) n = n.expression;
  return ts.isIdentifier(n) ? n.text : "";
}

/** Text of a string or template literal, with `${…}` for substitutions. */
function literalText(node: ts.Node, sf: ts.SourceFile): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => `\${…}${s.literal.text}`).join("");
  return node.getText(sf);
}

function fetchCall(node: ts.CallExpression, sf: ts.SourceFile): { method: string; url: string } {
  const [urlArg, options] = node.arguments;
  let method = "GET";
  if (options && ts.isObjectLiteralExpression(options)) {
    for (const prop of options.properties) {
      if (ts.isPropertyAssignment(prop) && prop.name.getText(sf) === "method" && ts.isStringLiteralLike(prop.initializer)) {
        method = prop.initializer.text.toUpperCase();
      }
    }
  }
  // `${base}/v1/charges` → `/v1/charges`; `/api/orders/${id}` → `/api/orders/*`
  const url = urlArg ? literalText(urlArg, sf).replace(/^\$\{…\}(?=\/)/, "").replace(/\$\{…\}/g, "*") : "?";
  return { method, url };
}

export function parseSql(raw: string): SqlEffect | undefined {
  if (!SQL_START.test(raw)) return undefined;
  const text = raw.replace(/\s+/g, " ").trim();
  const strip = (t: string) => t.replace(/"/g, "").replace(/^public\./, "");
  const insert = /\bINSERT\s+INTO\s+([\w."]+)/i.exec(text);
  const update = /\bUPDATE\s+([\w."]+)(?:\s+(?:AS\s+)?\w+)?\s+SET\s/i.exec(text);
  const del = /\bDELETE\s+FROM\s+([\w."]+)/i.exec(text);
  const where = /\bWHERE\s+(.+?)(?:\s+(?:RETURNING|ORDER BY|GROUP BY|LIMIT|FOR UPDATE|FOR SHARE|ON CONFLICT)\b|$)/i.exec(text)?.[1];
  const compact = text.replace(/\s+RETURNING\s+.*$/i, "");
  if (insert && !/^\s*(SELECT|WITH)\b/i.test(text)) {
    return { kind: "sql", op: "INSERT", tables: [strip(insert[1]!)], text: compact, onConflict: /\bON\s+CONFLICT\b/i.test(text) };
  }
  if (update && !/^\s*SELECT\b/i.test(text)) {
    return { kind: "sql", op: "UPDATE", tables: [strip(update[1]!)], text: compact, ...(where ? { where } : {}), guarded: !!where && !isKeyOnly(splitAnd(where)) };
  }
  if (del) {
    return { kind: "sql", op: "DELETE", tables: [strip(del[1]!)], text: compact, ...(where ? { where } : {}), guarded: !!where && !isKeyOnly(splitAnd(where)) };
  }
  const tables = [...text.matchAll(/\b(?:FROM|JOIN)\s+([\w."]+)/gi)].map((m) => strip(m[1]!)).filter((t) => !/^\(/.test(t));
  return {
    kind: "sql",
    op: "SELECT",
    tables: unique(tables),
    text: compact,
    ...(where ? { where } : {}),
    forUpdate: /\bFOR\s+(NO KEY\s+)?UPDATE\b/i.test(text),
  };
}

function splitAnd(where: string): string[] {
  return where.split(/\s+AND\s+/i).map((c) => c.trim());
}

/** `id = $1`, `s.id = $1`, `cart_id = $2`: conditions that only pick the row. */
function isKeyOnly(conditions: string[]): boolean {
  return conditions.every((c) => /^[\w.]*\bid\s*[:=]\s*(\$\d+|\w+|\?)$/i.test(c.replace(/\s+/g, " ").trim()) || /^[\w.]*_id\s*=\s*\$\d+$/i.test(c.trim()));
}

function jsxAttr(el: ts.JsxOpeningLikeElement, name: string, sf: ts.SourceFile): string | undefined {
  for (const prop of el.attributes.properties) {
    if (!ts.isJsxAttribute(prop) || prop.name.getText(sf) !== name || !prop.initializer) continue;
    if (ts.isStringLiteral(prop.initializer)) return prop.initializer.text;
    if (ts.isJsxExpression(prop.initializer) && prop.initializer.expression) return literalText(prop.initializer.expression, sf);
  }
  return undefined;
}

function jsxText(el: ts.JsxElement, sf: ts.SourceFile): string {
  const parts: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttributes(node)) return;
    if (ts.isJsxText(node)) {
      const t = node.getText(sf).trim();
      if (t) parts.push(t);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      parts.push(node.text);
    } else if (ts.isJsxExpression(node) && node.expression && !hasStringLiteral(node.expression)) {
      parts.push("…");
    } else ts.forEachChild(node, visit);
  };
  el.children.forEach(visit);
  // `Cart (`, `…`, `)` → `Cart (…)`; alternatives from a conditional stay apart.
  return unique(parts).join(" / ").replace(/ \/ … \/ /g, "…").replace(/ \/ …$/, "…").replace(/^… \/ /, "…");
}

function hasStringLiteral(node: ts.Node): boolean {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
  return node.getChildren().some(hasStringLiteral);
}

function mergeUi(into: UiFacts, from: UiFacts): void {
  into.buttons = unique([...into.buttons, ...from.buttons]);
  into.texts = unique([...into.texts, ...from.texts]);
  into.fields = unique([...into.fields, ...from.fields]);
  into.redirects = unique([...into.redirects, ...from.redirects]);
  for (const r of from.requests) if (!into.requests.some((x) => x.method === r.method && x.url === r.url)) into.requests.push(r);
  for (const l of from.links) if (!into.links.some((x) => x.href === l.href)) into.links.push(l);
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
