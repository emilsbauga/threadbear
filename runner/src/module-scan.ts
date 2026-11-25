// What a script or module loads, read from its syntax (scanModule), and how
// patch trust follows it from a folder (followOptions). Split out of
// patch-trust.ts (24 Nov 2026) as a plain move, so claude-trust.ts can follow
// a settings file's scripts without importing patch-trust.ts, which imports it
// (mikecann-lint's no-import-cycle).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'oxc-parser';
import { Reads, type FollowOptions } from './script-trust.ts';
import { realPath } from './platform.ts';

// scanModule for a script a patch's command runs: its problem as words.
export function scriptScan(src: string, file: string): { specifiers: string[]; packages: string[]; strings: string[]; launches?: string; problem?: string } {
  const { specifiers, packages, strings, problem: found, launches: at, sloppyThis } = scanModule(src, file);
  // A script run as CommonJS or plain JS is sloppy unless it says otherwise.
  const problem = found ?? (sloppyThis !== undefined && !/\.m[jt]s$/.test(file) && !(/\.[jt]sx?$/.test(file) && typeModule(path.dirname(file))) && !/^\s*(#![^\n]*\n\s*)?(\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*['"]use strict['"]/.test(src) ? { kind: 'computed' as const, line: sloppyThis, code: 'this' } : undefined);
  const launches = at ? `line ${at.line} starts other programs itself (\`${at.code}\`), and what it runs isn't followed: it could be read from a file no hash covers. Run them from a shell script instead.` : undefined;
  if (!problem) return { specifiers, packages, strings, ...(launches ? { launches } : {}) };
  return {
    specifiers,
    packages,
    strings,
    ...(launches ? { launches } : {}),
    problem: problem.kind === 'parse' ? `can't be read (${problem.code}, line ${problem.line}), so patch trust can't check what it loads.` : `line ${problem.line} loads code by a name worked out as it runs (\`${problem.code}\`), which patch trust can't follow.`,
  };
}

// Whether the package.json nearest `dir` says "type": "module", so its .js
// files are ES modules, always strict.
function typeModule(dir: string): boolean {
  for (let d = dir; ; d = path.dirname(d)) {
    const f = path.join(d, 'package.json');
    if (isFile(f)) {
      try {
        return (JSON.parse(fs.readFileSync(f, 'utf8')) as { type?: unknown }).type === 'module';
      } catch {
        return false;
      }
    }
    if (path.dirname(d) === d) return false;
  }
}

export const SCANNED = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.tsx', '.jsx'];

// What a module loads, read from its syntax by a real parser: the local
// specifiers it names with a plain string (static and dynamic imports,
// re-exports, require, `import x = require`), and the first load the scan
// can't follow (`problem`). Comments and strings are only words, so
// `import/*c*/(name)` can't slip past and `// import(x)` doesn't count;
// two regexes did both (Daybreak re-scan, 5 Nov). Parsed with oxc, as
// TypeScript 7 has no parser to call from JS and Node's own type
// stripping is experimental. A file that doesn't parse can't be checked.
//
// Covers how a module loads code by name: the module system and what hands
// it out (`createRequire`, `node:module`, `getBuiltinModule`), workers, vm
// and eval. Not shell commands or child processes: a patch's commands run
// anything by design, and the scripts they name are hashed (namedPaths).
// `strings`: every plain string in it, which a script's checks read for
// paths of files it may run (script-trust.ts).
// `packages`: the bare specifiers it imports (`zod`, `node:fs`), which are
// hashed only when the repo commits them (tracked-packages.ts).
//
// `data` and `worktree`: strings found only as fields of the default export
// that aren't commands (patchRoles), or only as its `worktree` setup and check
// (writeRunsAsCode). Never a reason to hash less: `strings` still has them.
//
// `launches`: where it starts other programs itself (a child_process or
// cluster import, a package known to wrap them, `Bun`, `Deno`,
// `process.execve`), which a script's follow can't see past: what it runs
// may be read from data no hash covers (Daybreak 165).
export type ModuleScan = { specifiers: string[]; packages: string[]; strings: string[]; data?: string[]; worktree?: string[]; launches?: { line: number; code: string }; sloppyThis?: number; problem?: { kind: 'computed' | 'parse'; line: number; code: string } };

export function scanModule(src: string, file: string): ModuleScan {
  const ext = path.extname(file);
  const sourceType = ext === '.cjs' || ext === '.cts' ? 'commonjs' : ext === '.mjs' || ext === '.mts' ? 'module' : 'unambiguous';
  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(file, src, { sourceType, preserveParens: false });
  } catch (e) {
    return { specifiers: [], packages: [], strings: [], problem: { kind: 'parse', line: 1, code: e instanceof Error ? e.message : String(e) } };
  }
  const lineAt = (at: number) => src.slice(0, at).split('\n').length;
  if (parsed.errors.length) {
    const err = parsed.errors[0];
    return { specifiers: [], packages: [], strings: [], problem: { kind: 'parse', line: lineAt(err.labels[0]?.start ?? 0), code: err.message } };
  }
  const specifiers = new Set<string>();
  const packages = new Set<string>();
  const strings = new Set<string>();
  // Each string by what it's for: one used as anything else even once is
  // kept out of `data` and `worktree`, as it might be a command.
  const roles = new Map<AstNode, 'data' | 'worktree'>();
  const seen = { data: new Set<string>(), worktree: new Set<string>(), other: new Set<string>() };
  const giveRole = (n: AstNode, role: 'data' | 'worktree') => {
    if (plainString(n) === undefined) return;
    roles.set(n, role);
    if (n.type === 'TemplateLiteral') roles.set(n.quasis[0], role);
  };
  let readsBack = false;
  let problem: { start: number; end: number } | undefined;
  let launches: AstNode | undefined;
  const launch = (n: AstNode) => {
    if (!launches || n.start < launches.start) launches = n;
  };
  const refuse = (n: AstNode) => {
    if (!problem || n.start < problem.start) problem = { start: n.start, end: n.end };
  };
  // A specifier written as one plain string: followed when it's a local
  // file, left alone when it's a package, refused when it hands out more.
  const named = (spec: AstNode | undefined, at: AstNode) => {
    const value = spec && plainString(spec);
    if (value === undefined) return refuse(at);
    // Node decodes `%6c` in a relative import's path, so `./%6caunch.mjs`
    // loads launch.mjs (Gemini's review of 165).
    if (/^\.{1,2}(\/|$)|^\//.test(value) && value.includes('%')) refuse(at);
    else if (/^\.{1,2}(\/|$)|^\//.test(value)) specifiers.add(value);
    // A URL's scheme has no case: `DATA:` and `FILE:` are those (Gemini's review).
    else if (/^file:/i.test(value)) {
      try {
        specifiers.add(fileURLToPath(value));
      } catch {
        refuse(at);
      }
    }
    // A data: module's own imports are in a string, and `#x` maps through
    // package.json to a local file this doesn't follow.
    else if (/^(data:|#)/i.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('node:') || LOADER_MODULES.includes(value)) refuse(at);
    // A package: hashed only when the repo commits it (tracked-packages.ts).
    else {
      packages.add(value);
      const bare = value.replace(/^node:/, '');
      // `import type` is gone before it runs.
      const typeOnly = at.importKind === 'type' || at.exportKind === 'type' || (Array.isArray(at.specifiers) && at.specifiers.length > 0 && at.specifiers.every((x: AstNode) => x.importKind === 'type' || x.exportKind === 'type'));
      if (!typeOnly && LAUNCHER_PACKAGES.has(bare.split('/').slice(0, value.startsWith('@') ? 2 : 1).join('/'))) launch(at);
      // node:process is the `process` object by another name: whole (a
      // default or namespace import, require, import()), it's read by
      // names this can't see, as `process` used as a value is; by name,
      // what it hands out counts as `process.x` would (Daybreak 165's
      // reviews: `import { execve } from 'node:process'`).
      if (!typeOnly && bare === 'process') {
        const specs: AstNode[] | undefined = at.type === 'ImportDeclaration' || (at.type === 'ExportNamedDeclaration' && at.source) ? at.specifiers : undefined;
        if (!specs || specs.some((x) => x.type !== 'ImportSpecifier' && x.type !== 'ExportSpecifier')) refuse(at);
        for (const x of specs ?? []) {
          const name = x.type === 'ImportSpecifier' ? (x.imported?.name ?? x.imported?.value) : (x.local?.name ?? x.local?.value);
          if (typeof name !== 'string' || name === 'default' || LOADER_NAMES.includes(name) || LOADER_PROPERTIES.includes(name) || CODE_REACH.includes(name) || PROCESS_WHOLE.includes(name)) refuse(x);
          if (name === 'execve') launch(x);
        }
      }
    }
  };
  // Identifiers and members a load handled already, so they aren't
  // refused as bare references to `require`.
  const handled = new Set<AstNode>();
  // `Reflect.x` members that are called right there: the only use allowed.
  const reflectCalls = new Set<AstNode>();
  // `plain`: inside a function that isn't a method, where `this` in sloppy
  // mode is globalThis (Gemini's review of 165).
  let sloppyThis: number | undefined;
  const stack: { node: AstNode; parent?: AstNode; key?: string; plain?: boolean }[] = [{ node: parsed.program as unknown as AstNode }];
  while (stack.length) {
    const { node, parent, key, plain } = stack.pop()!;
    if (node.type === 'ThisExpression' && plain && (sloppyThis === undefined || node.start < sloppyThis)) sloppyThis = node.start;
    if (TYPE_ONLY.has(node.type)) continue;
    const text = plainString(node);
    if (text !== undefined && strings.size < 5000) strings.add(text);
    // The fixed parts of `node ${x}`, which may name files too.
    if (node.type === 'TemplateElement' && typeof node.value?.cooked === 'string' && strings.size < 5000) strings.add(node.value.cooked);
    // `this` or a getter can read a literal back as something else (a hook's
    // `get run() { return this.title; }`), so nothing here has a role.
    if (node.type === 'ThisExpression' || (node.type === 'Property' && node.kind !== 'init')) readsBack = true;
    const said = text ?? (node.type === 'TemplateElement' && typeof node.value?.cooked === 'string' ? (node.value.cooked as string) : undefined);
    if (said !== undefined) seen[roles.get(node) ?? 'other'].add(said);
    switch (node.type) {
      case 'ExportDefaultDeclaration':
        if (node.declaration.type === 'ObjectExpression') patchRoles(node.declaration, giveRole);
        break;
      case 'ImportDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
        if (node.source) named(node.source, node);
        break;
      case 'ImportExpression':
        named(node.source, node);
        break;
      case 'TSImportEqualsDeclaration':
        if (node.moduleReference?.type === 'TSExternalModuleReference') named(node.moduleReference.expression, node);
        break;
      case 'CallExpression': {
        const callee = node.callee;
        const isRequire = (callee.type === 'Identifier' && callee.name === 'require') || (callee.type === 'MemberExpression' && propertyName(callee) === 'require');
        const isResolve = callee.type === 'MemberExpression' && callee.object.type === 'MetaProperty' && propertyName(callee) === 'resolve';
        if (isRequire || isResolve) {
          handled.add(callee);
          named(node.arguments[0], node);
        }
        break;
      }
      case 'Identifier':
        if (handled.has(node) || !isReference(parent, key)) break;
        // Reflect only called in place (`Reflect.has(o, k)`), below.
        if (node.name === 'Reflect') break;
        // oxc decodes an escaped name, so `B\u0075n` is Bun here.
        if ((node.name === 'Bun' || node.name === 'Deno') && parent?.type !== 'UnaryExpression') launch(node);
        if (LOADER_NAMES.includes(node.name) || CODE_REACH.includes(node.name)) refuse(node);
        // `process`, `globalThis` and the like as values (`const p = process`,
        // `Object.entries(process)`): what's on them is then read by a name
        // this can't see (Gemini's review). Their plain members, `typeof`,
        // and `module.exports = ...` read nothing that way.
        if (RISKY_OBJECTS.includes(node.name) && node.name !== 'require' && !(parent?.type === 'MemberExpression' && key === 'object') && parent?.type !== 'UnaryExpression') refuse(node);
        break;
      case 'MemberExpression': {
        const name = propertyName(node);
        if (name === undefined) {
          // `process[k]`: any property, so any loader, by a name worked out later.
          const o = node.object;
          if (o.type === 'MetaProperty' || riskyRef(o)) refuse(node);
        } else if (!handled.has(node) && (LOADER_PROPERTIES.includes(name) || CODE_REACH.includes(name))) refuse(node);
        if ((name === 'execve' || name === 'Bun' || name === 'Deno') && riskyRef(node.object)) launch(node);
        // `process.mainModule`, `module.children`, `require.main`: a module,
        // whose own require can then be reached by a worked-out name.
        if (name !== undefined && WHOLE_MEMBERS.includes(name) && riskyRef(node.object)) refuse(node);
        // `globalThis.process`, `global.globalThis`: the object itself, so
        // as a value it's read as `process` used as one would be.
        if (node.object.type !== 'MetaProperty' && riskyRef(node) && !(parent?.type === 'MemberExpression' && key === 'object') && parent?.type !== 'UnaryExpression') refuse(node);
        break;
      }
      // `import.meta` handed on whole: Bun's has a require (Gemini's
      // review of 165). Its plain members (`.url`, `.dirname`) are fine.
      case 'MetaProperty':
        if (node.meta?.name === 'import' && !(parent?.type === 'MemberExpression' && key === 'object' && !parent.computed)) refuse(node);
        break;
      // `const { eval: run } = globalThis`, `{ constructor: F } = f`: a
      // pattern's key reads that property, though it isn't a reference
      // (Daybreak 154). A worked-out key could read any of them.
      case 'Property':
        // `{ __proto__: f }` makes f the prototype: its constructor then reads as o's.
        if (parent?.type === 'ObjectExpression' && !node.computed && node.kind === 'init' && !node.shorthand && propertyKey(node) === '__proto__') refuse(node);
        if (parent?.type === 'ObjectPattern') {
          const name = propertyKey(node);
          // `{ ['eval']: run }` names it too (Codex's review).
          // A worked-out key reads like `o[k]` (see CODE_REACH); a number reads no loader.
          const read = name ?? plainString(node.key);
          if (read !== undefined && (LOADER_PROPERTIES.includes(read) || CODE_REACH.includes(read) || LOADER_NAMES.includes(read))) refuse(node);
          if (read === 'execve' || read === 'Bun' || read === 'Deno') launch(node);
          if (read !== undefined && PROCESS_WHOLE.includes(read)) refuse(node);
        }
        break;
    }
    // `Reflect.get(f, 'constructor')`: a string that's exactly such a name,
    // handed to what reads a property by one, reaches it without writing it
    // as one (`globalThis['eval']` is a member above). Not any such string:
    // `case 'eval':` in a CLI's switch, or `Object.hasOwn(o, 'constructor')`,
    // reads nothing. And Reflect only ever called in place, so it can't be
    // handed on as `const get = Reflect.get` (Codex's review).
    if (node.type === 'Identifier' && node.name === 'Reflect' && isReference(parent, key) && !(parent?.type === 'MemberExpression' && key === 'object' && reflectCalls.has(parent))) refuse(node);
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.object.type === 'Identifier' && node.callee.object.name === 'Reflect') {
      reflectCalls.add(node.callee);
      const method = propertyName(node.callee);
      if (method === undefined) refuse(node);
      else if (method === 'get' || method === 'getOwnPropertyDescriptor') {
        // Reads a property by name: only a plain one that isn't a loader's.
        const named = node.arguments[1] && plainString(node.arguments[1]);
        if (named === undefined || CODE_REACH.includes(named) || LOADER_NAMES.includes(named) || LOADER_PROPERTIES.includes(named) || RISKY_OBJECTS.includes(named) || PROCESS_WHOLE.includes(named)) refuse(node);
        if (named === 'execve' || named === 'Bun' || named === 'Deno') launch(node);
      }
    }
    // A function's own `this`: a method's is its object, a plain one's may
    // be globalThis; an arrow's is the one around it.
    const method = parent?.type === 'MethodDefinition' || (parent?.type === 'Property' && (parent.method || parent.kind !== 'init'));
    const inner = node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' ? !method : node.type === 'PropertyDefinition' || node.type === 'StaticBlock' || node.type === 'ClassBody' ? false : plain;
    for (const k of Object.keys(node)) {
      if (TYPE_KEYS.has(k)) continue;
      const v = node[k];
      for (const child of Array.isArray(v) ? v : [v]) {
        if (child && typeof child === 'object' && typeof child.type === 'string') stack.push({ node: child as AstNode, parent: node, key: k, plain: inner });
      }
    }
  }
  return {
    ...(sloppyThis !== undefined ? { sloppyThis: lineAt(sloppyThis) } : {}),
    specifiers: [...specifiers],
    packages: [...packages],
    strings: [...strings],
    data: readsBack ? [] : [...seen.data].filter((s) => !seen.other.has(s) && !seen.worktree.has(s)),
    worktree: readsBack ? [] : [...seen.worktree].filter((s) => !seen.other.has(s)),
    ...(launches ? { launches: { line: lineAt(launches.start), code: src.slice(launches.start, launches.end).replace(/\s+/g, ' ').slice(0, 80) } } : {}),
    ...(problem ? { problem: { kind: 'computed' as const, line: lineAt(problem.start), code: src.slice(problem.start, problem.end).replace(/\s+/g, ' ').slice(0, 80) } } : {}),
  };
}

// oxc's ESTree nodes, loosely: the scan only reads a few fields.
type AstNode = { type: string; start: number; end: number; [field: string]: any };

// Names that load code, or hand out something that can, when used as values.
const LOADER_NAMES = ['require', 'eval', 'Function', 'createRequire', 'getBuiltinModule', 'dlopen'];
// `loadExtension`: node:sqlite's, which loads a native library.
const LOADER_PROPERTIES = ['require', 'createRequire', 'getBuiltinModule', 'dlopen', '_load', 'binding', '_linkedBinding', 'loadExtension'];
// What on `process` hands out a module, and so a loader, by its own names.
const PROCESS_WHOLE = ['mainModule', 'moduleLoadList'];
// Members of process, module and require that hand out a module.
const WHOLE_MEMBERS = [...PROCESS_WHOLE, 'children', 'parent', 'main', 'cache', '_cache'];
// What reaches code made from a string or bytes without a loader's name
// (Daybreak 154, 21 Nov 2026): `eval` and `Function` as properties
// (`globalThis.eval`), any function's `constructor` (`(() => {}).constructor`
// is Function, an async one's AsyncFunction), what lists a prototype's
// hidden properties with their values (`getOwnPropertyDescriptors` hands
// out `constructor` without naming it), and WebAssembly, which compiles
// bytes. Not `getPrototypeOf`, everyday code that reaches nothing by
// itself: from a prototype it's still one of these. As a name, a
// property, a string or a pattern's key, all refused: a script whose
// payload is data until it evaluates it isn't one the hash can vouch for.
// Not a class's own `constructor() {}` or an object literal's key, which
// define rather than read. What can't be refused by a scan is a script
// written to hide it (`o[a][b](c)` with keys worked out as it runs), and a
// child process running whatever it's handed, which a patch's commands do
// by design: the card that trusts it is what reads for those.
const CODE_REACH = [
  'eval', 'Function', 'constructor', 'AsyncFunction', 'GeneratorFunction', 'AsyncGeneratorFunction',
  'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors', '__lookupGetter__', 'WebAssembly', 'Reflect', '__proto__',
  'setPrototypeOf',
];
// Modules that load code by a name or from a string: the module system, vm,
// workers, and inspector and repl, which evaluate what they're sent.
const LOADER_MODULES = [
  'module', 'node:module', 'vm', 'node:vm', 'worker_threads', 'node:worker_threads', 'inspector', 'node:inspector',
  'inspector/promises', 'node:inspector/promises', 'repl', 'node:repl', 'node:test', 'test', 'sqlite', 'node:sqlite',
];
// Modules that start other programs (ModuleScan.launches): Node's own, and
// the packages most used to wrap them. Any installed package could, and
// isn't followed, as for patches; these are the ones named for it.
const LAUNCHER_PACKAGES = new Set([
  'child_process', 'cluster', 'bun', 'execa', 'cross-spawn', 'zx', 'shelljs', 'node-pty', '@homebridge/node-pty-prebuilt-multiarch', 'tinyexec',
  'nano-spawn', 'spawn-sync', 'cross-spawn-async', '@npmcli/promise-spawn', '@npmcli/run-script', '@expo/spawn-async', 'spawndamnit',
  'dax-sh', 'foreground-child', 'open', 'opn', 'node-cmd',
]);
// Objects a computed `[k]` on could reach a loader through.
const RISKY_OBJECTS = ['globalThis', 'global', 'process', 'module', 'require', 'self', 'window'];
// One of those, by its name or as a plain member of another
// (`globalThis.process`, `global.globalThis.process`).
function riskyRef(n: AstNode): boolean {
  if (n.type === 'Identifier') return RISKY_OBJECTS.includes(n.name);
  if (n.type === 'MemberExpression' || n.type === 'ChainExpression') {
    const m = n.type === 'ChainExpression' ? n.expression : n;
    if (m.type !== 'MemberExpression') return false;
    const name = propertyName(m);
    return name !== undefined && RISKY_OBJECTS.includes(name) && riskyRef(m.object);
  }
  if (n.type === 'ParenthesizedExpression' || n.type === 'TSAsExpression' || n.type === 'TSNonNullExpression' || n.type === 'TSSatisfiesExpression') return riskyRef(n.expression);
  return false;
}
// TypeScript types: gone before the code runs, so nothing in them loads.
const TYPE_KEYS = new Set(['typeAnnotation', 'typeArguments', 'typeParameters', 'returnType', 'superTypeArguments', 'implements']);
const TYPE_ONLY = new Set(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSDeclareFunction']);

function plainString(n: AstNode): string | undefined {
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis[0]?.value?.cooked ?? undefined;
  return undefined;
}

// The literals of a patch's `export default { ... }` that aren't commands:
// shown, sent to an agent or matched, never handed to a shell
// (readPatchModule in patches.ts). Only there, written in place: that object
// has no name, so nothing else in the file can run what's in it, where
// `{ title: 'x' }` anywhere else might be read back as `run: o.title` (Codex's
// review). Anything less plain than this isn't given a role.
const PATCH_FIELDS = new Set(['icon', 'appliesTo']);
const ITEM_FIELDS = new Set(['title', 'note', 'icon', 'on', 'tell', 'prompt', 'url', 'edited']);
function patchRoles(patch: AstNode, give: (n: AstNode, role: 'data' | 'worktree') => void): void {
  const fields = (o: AstNode): [string, AstNode][] => o.properties.flatMap((p: AstNode) => {
    const name = p.type === 'Property' ? propertyKey(p) : undefined;
    return name === undefined ? [] : [[name, p.value] as [string, AstNode]];
  });
  const list = (v: AstNode): AstNode[] => (v.type === 'ArrayExpression' ? v.elements.filter(Boolean) : [v]);
  for (const [name, value] of fields(patch)) {
    if (PATCH_FIELDS.has(name)) list(value).forEach((v) => give(v, 'data'));
    else if (name === 'worktree' && value.type === 'ObjectExpression') {
      for (const [k, v] of fields(value)) {
        // Not `teardown`: it runs in the thread's worktree as the agent left
        // it, as the thread is archived, so what it reaches counts as code
        // like any other command's.
        if (k === 'setup' || k === 'check') give(v, 'worktree');
        else if (k === 'keep') list(v).forEach((e) => give(e, 'data'));
      }
    } else if ((name === 'actions' || name === 'panels' || name === 'hooks') && value.type === 'ArrayExpression') {
      for (const item of list(value)) {
        if (item.type === 'ObjectExpression') for (const [k, v] of fields(item)) if (ITEM_FIELDS.has(k)) give(v, 'data');
      }
    }
  }
}

// The name of an object literal's `name: value`, unless it's worked out.
function propertyKey(n: AstNode): string | undefined {
  if (n.computed) return undefined;
  return n.key.type === 'Identifier' ? n.key.name : plainString(n.key);
}

// `a.b` and `a['b']` name `b`; `a[k]` names nothing the scan can know.
function propertyName(n: AstNode): string | undefined {
  if (!n.computed) return n.property.type === 'Identifier' ? n.property.name : undefined;
  return plainString(n.property);
}

// Whether an identifier is a value in code, not a property's name or a label.
function isReference(parent: AstNode | undefined, key: string | undefined): boolean {
  if (!parent) return true;
  if (key === 'property' && parent.type === 'MemberExpression') return !!parent.computed;
  if (key === 'key') return !!parent.computed;
  return key !== 'label' && parent.type !== 'MetaProperty';
}

// Paths a module names that start ./ or ../, anywhere: in a command
// (`setup: "./scripts/setup.sh --fast"`), an argument, a comment. Extra
// matches only add files to the hash. Pictures are left out: an icon is
// only ever shown, and redrawing one shouldn't ask about the patch again.
//
// Linear in the text: the match is one greedy run with nothing after it to
// backtrack into, and the trailing dots and colons (a sentence's full stop)
// come off by a loop. `/[.:]+$/` restarted at every dot of a long run of
// them, so `./` and a few MB of dots held the runner for minutes before
// anyone was asked anything (Gautam's scan, 6 Nov). A match longer than
// any path can be (PATH_MAX is 1024 on macOS, 4096 on Linux) is no file.
export const MAX_PATH = 4096;

export function namedPaths(src: string): string[] {
  const out = new Set<string>();
  const re = /(?<![\w./\\-])\.\.?\/[^\s'"`;&|()<>{}[\],*?!$=\\]+/g;
  for (let m; (m = re.exec(src)); ) {
    const found = m[0];
    if (found.length > MAX_PATH) continue;
    let end = found.length;
    while (end > 0 && (found[end - 1] === '.' || found[end - 1] === ':')) end--;
    const p = found.slice(0, end);
    if (p.length > 2 && !PICTURES.includes(path.extname(p).toLowerCase())) out.add(p);
  }
  return [...out];
}

// What script-trust needs to follow a command run from `folder` (a Claude
// Code hook, claude-trust.ts) the way it follows a patch's: the same
// module scan and import resolution, bounded by the repo's top.
// A JavaScript file that starts programs itself can't be followed past
// (FollowOptions.launches): a schedule's check run by its digest, or a hook.
export function followOptions(folder: string, reads?: Reads): FollowOptions {
  const real = realpath(folder);
  return { folder: real, top: repoTop(real), scanJs: scriptScan, resolveImport: (dir, spec) => resolveHelper(dir, spec, reads), namedPaths, launches: true, ...(reads ? { reads } : {}) };
}

// The top of the git checkout (or worktree) `dir` is in, else `dir`.
export function repoTop(dir: string): string {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return dir;
  }
}

export const PICTURES = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.icns', '.pdf', '.heic'];

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// Where Node (or a bundler-ish habit) would find `spec`: as written, then
// with a script extension, then as a folder's index. As written when none
// is there, so it's hashed as missing.
export function resolveHelper(dir: string, spec: string, reads?: Reads): string {
  const base = path.resolve(dir, spec.replace(/[?#].*$/, ''));
  const tries = [base, ...[...SCANNED, '.json'].map((e) => base + e), ...SCANNED.map((e) => path.join(base, 'index' + e))];
  for (const t of tries) {
    // Each try is noted, so one turning up (or a link retargeted) shows.
    if (isFile(t)) return reads ? (reads.real(t) ?? t) : realpath(t);
    reads?.real(t);
  }
  return base;
}

// The real form of a path, as it is when it isn't there (platform.ts): the
// one every path here is compared by.
export function realpath(p: string): string {
  return realPath(p);
}
