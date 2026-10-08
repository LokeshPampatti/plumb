import Parser from 'web-tree-sitter';
import { createRequire } from 'node:module';
import { LANGS, langFor, type LangSpec } from './languages.js';

const require = createRequire(import.meta.url);
type SyntaxNode = Parser.SyntaxNode;

export interface Param {
  name: string;
  optional: boolean;
  variadic: boolean;
}

export interface SymbolDef {
  name: string;
  kind: 'function' | 'method' | 'class';
  line: number;
  endLine: number;
  container?: string;
  params: Param[] | null;
  /** One-line signature text, e.g. `function charge(user, amount, currency)` */
  signature: string;
  exported: boolean;
  /** Decorator names (Python), which may change the call signature. */
  decorators?: string[];
}

export interface CallSite {
  name: string;
  qualifier?: string;
  line: number;
  positional: number;
  keywords: string[];
  spread: boolean;
  /** Name of the enclosing definition, if any. */
  inDef?: string;
}

export interface ImportRef {
  line: number;
  module: string;
  /** imported -> local alias; '*' means namespace import bound to `local`; 'default' for default imports */
  names: { imported: string; local: string }[];
  reexport?: boolean;
}

export interface FileFacts {
  lang: string;
  defs: SymbolDef[];
  calls: CallSite[];
  imports: ImportRef[];
  /** Names this module makes importable (top-level/exported). Only for Python and JS/TS. */
  names?: string[];
  /** True when the module can export names we can't see (`export *`, `from x import *`, `__getattr__`, CommonJS). */
  wildcard?: boolean;
  /** The parse tree contains ERROR nodes, so absence of a name is not proof. */
  syntaxErrors?: boolean;
  parseError?: string;
}

let initPromise: Promise<void> | null = null;
const languages = new Map<string, Parser.Language>();
const parsers = new Map<string, Parser>();

async function init(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  return initPromise;
}

async function parserFor(spec: LangSpec): Promise<Parser | null> {
  if (!spec.wasm) return null;
  await init();
  let p = parsers.get(spec.id);
  if (p) return p;
  let lang = languages.get(spec.id);
  if (!lang) {
    lang = await Parser.Language.load(require.resolve(`tree-sitter-wasms/out/${spec.wasm}`));
    languages.set(spec.id, lang);
  }
  p = new Parser();
  p.setLanguage(lang);
  parsers.set(spec.id, p);
  return p;
}

const IDENT_TYPES = new Set([
  'identifier',
  'property_identifier',
  'field_identifier',
  'simple_identifier',
  'type_identifier',
  'name',
  'constant',
  'shorthand_property_identifier',
  'private_property_identifier',
]);

// Callees with no name of their own: calling them says nothing about any named definition.
const ANONYMOUS = /func_literal|function|arrow|lambda|closure|block|literal|parenthesized|call_expression|invocation|subscript|index_expression|template|string|object|array|table|anonymous|new_expression|await|conditional|binary|ternary/;

function nameOf(node: SyntaxNode | null, depth = 0): string | undefined {
  if (!node || depth > 6) return undefined;
  if (IDENT_TYPES.has(node.type)) return node.text.replace(/^#/, '');
  if (ANONYMOUS.test(node.type) && !node.type.endsWith('declarator')) return undefined;
  for (const f of ['property', 'attribute', 'field', 'name', 'declarator', 'function']) {
    const c = node.childForFieldName(f);
    if (c) return nameOf(c, depth + 1);
  }
  if (node.type === 'navigation_expression' || node.type === 'navigation_suffix') {
    const last = node.namedChildren[node.namedChildren.length - 1];
    return nameOf(last, depth + 1);
  }
  if (node.type.startsWith('generic')) return nameOf(node.namedChildren[0], depth + 1);
  const named = node.namedChildren;
  if (named.length) return nameOf(named[named.length - 1], depth + 1);
  return undefined;
}

function qualifierOf(callee: SyntaxNode | null): string | undefined {
  if (!callee) return undefined;
  for (const f of ['object', 'operand', 'scope', 'path']) {
    const c = callee.childForFieldName(f);
    if (c) return c.text.length <= 60 ? c.text : undefined;
  }
  if (callee.type === 'attribute' || callee.type === 'member_access_expression' || callee.type === 'navigation_expression') {
    const first = callee.namedChildren[0];
    return first && first.text.length <= 60 ? first.text : undefined;
  }
  return undefined;
}

function findChildOfType(node: SyntaxNode, types: string[], depth = 3): SyntaxNode | null {
  if (depth < 0) return null;
  for (const c of node.namedChildren) {
    if (types.includes(c.type)) return c;
  }
  for (const c of node.namedChildren) {
    const r = findChildOfType(c, types, depth - 1);
    if (r) return r;
  }
  return null;
}

function paramsNode(node: SyntaxNode, spec: LangSpec): SyntaxNode | null {
  const direct = node.childForFieldName(spec.paramsField) ?? node.childForFieldName('parameters');
  if (direct) return direct;
  // C/C++: function_definition -> declarator(function_declarator) -> parameters
  const decl = node.childForFieldName('declarator');
  if (decl) {
    const fd = decl.type === 'function_declarator' ? decl : findChildOfType(decl, ['function_declarator'], 3);
    if (fd) return fd.childForFieldName('parameters');
  }
  // Kotlin/Swift keep parameters as plain children.
  return findChildOfType(node, ['function_value_parameters', 'parameter_clause', 'formal_parameters', 'parameters'], 1);
}

function extractParams(pnode: SyntaxNode | null, spec: LangSpec, isMethod: boolean): Param[] | null {
  if (!pnode) return null;
  const out: Param[] = [];
  // A single bare identifier (JS arrow `x => x`) or Python lambda.
  let kids = IDENT_TYPES.has(pnode.type) ? [pnode] : pnode.namedChildren;
  // Kotlin and Swift put default values next to the parameter, not inside it.
  const siblingDefaults = spec.id === 'kotlin' || spec.id === 'swift';
  if (siblingDefaults) kids = kids.filter((k) => k.type === 'parameter');
  for (const c of kids) {
    if (c.type === 'comment' || c.type === 'positional_separator' || c.type === 'keyword_separator') continue;
    if (c.type === 'self_parameter' || c.type === 'receiver_parameter') continue;
    const text = c.text;
    if ((spec.id === 'c' || spec.id === 'cpp') && text.trim() === 'void') continue;
    if (siblingDefaults) {
      const nm = nameOf(c.namedChildren.find((k) => IDENT_TYPES.has(k.type)) ?? c) ?? text;
      out.push({ name: nm, optional: c.nextSibling?.type === '=', variadic: /\bvararg\b|\.\.\./.test(text) });
      continue;
    }
    let name = nameOf(c.childForFieldName('pattern') ?? c.childForFieldName('name') ?? c) ?? text;
    if (c.type === 'parameter_declaration' && spec.id === 'go') {
      // Go allows `a, b int` in one declaration: count every name.
      const names = c.namedChildren.filter((n) => n.type === 'identifier');
      if (names.length > 1) {
        for (const n of names) out.push({ name: n.text, optional: false, variadic: false });
        continue;
      }
    }
    name = name.replace(/^[*&.]+/, '');
    if (out.length === 0 && (spec.receiverNames.includes(name) || (isMethod && spec.receiverNames.includes(text)))) continue;
    if (spec.id === 'typescript' || spec.id === 'tsx') {
      if (name === 'this' || /^this\s*(:|$)/.test(text)) continue;
    }
    const variadic =
      spec.variadicParams.includes(c.type) ||
      c.namedChildren.some((k) => spec.variadicParams.includes(k.type) || k.type === 'rest_pattern') ||
      /^\s*(\.\.\.|\*{1,2}[A-Za-z_])/.test(text) ||
      (spec.id === 'csharp' && /^\s*params\s/.test(text)) ||
      /\.\.\.\s*$/.test(text) ||
      /\.\.\.\s*[A-Za-z_]\w*\s*$/.test(text);
    const optional =
      !variadic &&
      (spec.optionalParams.includes(c.type) ||
        c.childForFieldName('default_value') != null ||
        c.childForFieldName('value') != null ||
        /^[^=]*[^=!<>]=[^=>]/.test(text) ||
        /\?\s*:/.test(text.split('=')[0] ?? ''));
    out.push({ name, optional, variadic });
  }
  return out;
}

function signatureText(node: SyntaxNode, source: string): string {
  const body = node.childForFieldName('body');
  const end = body ? body.startIndex : node.endIndex;
  const sig = source.slice(node.startIndex, end).replace(/\s+/g, ' ').trim();
  return sig.length > 200 ? sig.slice(0, 197) + '...' : sig;
}

function isExported(node: SyntaxNode, spec: LangSpec, name: string): boolean {
  if (spec.id === 'python') return !name.startsWith('_');
  if (spec.id === 'go') return /^[A-Z]/.test(name);
  if (spec.id === 'typescript' || spec.id === 'tsx' || spec.id === 'javascript') {
    let p: SyntaxNode | null = node.parent;
    for (let i = 0; p && i < 3; i++, p = p.parent) if (p.type === 'export_statement') return true;
    return false;
  }
  return !/\bprivate\b/.test(node.text.slice(0, 80));
}

const FN_VALUE_TYPES = new Set(['arrow_function', 'function', 'function_expression', 'generator_function', 'lambda']);

function argInfo(callNode: SyntaxNode, spec: LangSpec): { positional: number; keywords: string[]; spread: boolean } | null {
  let args =
    callNode.childForFieldName('arguments') ??
    findChildOfType(callNode, ['value_arguments', 'argument_list', 'arguments'], 2);
  if (!args) {
    // Rust macro-like or template literal calls (tagged templates): skip.
    return null;
  }
  if (args.type === 'template_string') return null;
  if (args.type === 'generator_expression') return { positional: 1, keywords: [], spread: false };
  let positional = 0;
  const keywords: string[] = [];
  let spread = false;
  const keywordLangs = ['python', 'kotlin', 'csharp', 'swift', 'scala', 'php'];
  for (const a of args.namedChildren) {
    if (a.type === 'comment') continue;
    if (/spread|splat/.test(a.type) || /^\s*(\.\.\.|\*)/.test(a.text) || (spec.id === 'go' && /\.\.\.\s*$/.test(a.text))) {
      spread = true;
      continue;
    }
    if (a.type === 'keyword_argument') {
      keywords.push(a.childForFieldName('name')?.text ?? a.text.split('=')[0].trim());
      continue;
    }
    if (keywordLangs.includes(spec.id)) {
      const m = a.text.match(/^\s*([A-Za-z_]\w*)\s*(?:=(?!=)|:(?!:))/);
      if (m && a.type !== 'string' && a.type !== 'lambda') {
        keywords.push(m[1]);
        continue;
      }
    }
    positional++;
  }
  // Kotlin/Swift trailing lambdas count as one more argument.
  if ((spec.id === 'kotlin' || spec.id === 'swift') && findChildOfType(callNode, ['annotated_lambda', 'lambda_literal'], 2)) positional++;
  return { positional, keywords, spread };
}

function importsOf(node: SyntaxNode, spec: LangSpec): ImportRef | null {
  const line = node.startPosition.row + 1;
  if (spec.id === 'typescript' || spec.id === 'tsx' || spec.id === 'javascript') {
    if (node.type === 'import_statement' || (node.type === 'export_statement' && node.childForFieldName('source'))) {
      const src = node.childForFieldName('source');
      if (!src) return null;
      const module = src.text.replace(/^['"`]|['"`]$/g, '');
      const names: { imported: string; local: string }[] = [];
      const walk = (n: SyntaxNode) => {
        for (const c of n.namedChildren) {
          if (c.type === 'import_specifier' || c.type === 'export_specifier') {
            const imported = c.childForFieldName('name')?.text ?? c.text;
            const local = c.childForFieldName('alias')?.text ?? imported;
            names.push({ imported, local });
          } else if (c.type === 'namespace_import' || c.type === 'namespace_export') {
            const id = c.namedChildren.find((k) => k.type === 'identifier');
            names.push({ imported: '*', local: id?.text ?? '*' });
          } else if (c.type === 'identifier' && n.type === 'import_clause') {
            names.push({ imported: 'default', local: c.text });
          } else if (c.type === 'import_clause' || c.type === 'named_imports' || c.type === 'export_clause') {
            walk(c);
          }
        }
      };
      walk(node);
      if (node.type === 'export_statement' && names.length === 0) names.push({ imported: '*', local: '*' });
      return { line, module, names, reexport: node.type === 'export_statement' };
    }
    return null;
  }
  if (spec.id === 'python') {
    if (node.type === 'import_from_statement') {
      const mod = node.childForFieldName('module_name');
      const module = mod?.text ?? '';
      const names: { imported: string; local: string }[] = [];
      for (const c of node.namedChildren) {
        if (mod && c.startIndex === mod.startIndex) continue;
        if (c.type === 'dotted_name') names.push({ imported: c.text, local: c.text });
        else if (c.type === 'aliased_import') {
          const n = c.childForFieldName('name')?.text ?? '';
          names.push({ imported: n, local: c.childForFieldName('alias')?.text ?? n });
        } else if (c.type === 'wildcard_import') names.push({ imported: '*', local: '*' });
      }
      return { line, module, names };
    }
    if (node.type === 'import_statement') {
      const names: { imported: string; local: string }[] = [];
      let module = '';
      for (const c of node.namedChildren) {
        if (c.type === 'dotted_name') {
          module = c.text;
          names.push({ imported: '*', local: c.text });
        } else if (c.type === 'aliased_import') {
          module = c.childForFieldName('name')?.text ?? '';
          names.push({ imported: '*', local: c.childForFieldName('alias')?.text ?? module });
        }
      }
      return module ? { line, module, names } : null;
    }
    return null;
  }
  if (spec.id === 'go' && node.type === 'import_spec') {
    const path = node.childForFieldName('path')?.text.replace(/"/g, '') ?? '';
    const alias = node.childForFieldName('name')?.text ?? path.split('/').pop() ?? path;
    return { line, module: path, names: [{ imported: '*', local: alias }] };
  }
  if (spec.id === 'java' && node.type === 'import_declaration') {
    const text = node.text.replace(/^import\s+(static\s+)?/, '').replace(/;\s*$/, '').trim();
    const last = text.split('.').pop() ?? text;
    return { line, module: text, names: [{ imported: last, local: last }] };
  }
  return null;
}

export async function extractFacts(path: string, source: string): Promise<FileFacts | null> {
  const spec = langFor(path);
  if (!spec) return null;
  if (!spec.wasm) return regexFacts(spec, source);
  const parser = await parserFor(spec);
  if (!parser) return regexFacts(spec, source);

  let tree: Parser.Tree;
  try {
    tree = parser.parse(source);
  } catch (e) {
    return { lang: spec.id, defs: [], calls: [], imports: [], parseError: String(e) };
  }

  const facts: FileFacts = { lang: spec.id, defs: [], calls: [], imports: [] };
  const defStack: string[] = [];
  const classStack: string[] = [];

  const visit = (node: SyntaxNode) => {
    let pushedDef = false;
    let pushedClass = false;
    const kind = spec.defs[node.type];

    if (kind) {
      const nameNode = node.childForFieldName('name') ?? null;
      let name = nameNode ? nameNode.text : nameOf(node.childForFieldName('declarator'));
      if (!name && (spec.id === 'kotlin' || spec.id === 'swift')) {
        name = node.namedChildren.find((c) => c.type === 'simple_identifier' || c.type === 'type_identifier')?.text;
      }
      if (name) {
        const isMethod = kind === 'method' || (kind === 'function' && classStack.length > 0);
        const params = kind === 'class' ? null : extractParams(paramsNode(node, spec), spec, isMethod);
        facts.defs.push({
          name,
          kind: kind === 'function' && classStack.length > 0 ? 'method' : kind,
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          container: classStack[classStack.length - 1],
          params,
          signature: signatureText(node, source),
          exported: isExported(node, spec, name),
          decorators:
            node.parent?.type === 'decorated_definition'
              ? node.parent.namedChildren.filter((c) => c.type === 'decorator').map((c) => c.text.replace(/^@/, '').split('(')[0].trim())
              : undefined,
        });
        defStack.push(name);
        pushedDef = true;
        if (kind === 'class') {
          classStack.push(name);
          pushedClass = true;
        }
      }
    } else if (
      (node.type === 'variable_declarator' || node.type === 'public_field_definition' || node.type === 'field_definition' || node.type === 'pair') &&
      (spec.id === 'typescript' || spec.id === 'tsx' || spec.id === 'javascript')
    ) {
      const value = node.childForFieldName('value');
      const nameNode = node.childForFieldName('name') ?? node.childForFieldName('property') ?? node.childForFieldName('key');
      if (value && FN_VALUE_TYPES.has(value.type) && nameNode && IDENT_TYPES.has(nameNode.type)) {
        const p = value.childForFieldName('parameters') ?? value.childForFieldName('parameter');
        const name = nameNode.text;
        const inClass = classStack.length > 0 && node.type !== 'variable_declarator';
        facts.defs.push({
          name,
          kind: inClass ? 'method' : 'function',
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          container: inClass ? classStack[classStack.length - 1] : undefined,
          params: extractParams(p, spec, inClass),
          signature: signatureText(value, source).replace(/^/, `${name} = `),
          exported: isExported(node.parent ?? node, spec, name),
        });
        defStack.push(name);
        pushedDef = true;
      }
    }

    if (spec.calls.includes(node.type)) {
      const callee =
        node.childForFieldName('function') ??
        node.childForFieldName('constructor') ??
        node.childForFieldName('name') ??
        node.childForFieldName('type') ??
        node.childForFieldName('method') ??
        node.namedChildren[0] ??
        null;
      const name = nameOf(callee);
      const info = argInfo(node, spec);
      if (name && info && !/^(require|import|super|print|len|str|int|float|list|dict|set|tuple|isinstance|getattr|setattr|hasattr|console)$/.test(name)) {
        facts.calls.push({
          name,
          qualifier: node.type === 'method_invocation' ? node.childForFieldName('object')?.text : qualifierOf(callee),
          line: node.startPosition.row + 1,
          ...info,
          inDef: defStack[defStack.length - 1],
        });
      }
      // CommonJS require binds like an import.
      if (name === 'require' && (spec.id === 'javascript' || spec.id === 'typescript' || spec.id === 'tsx')) {
        const arg = node.childForFieldName('arguments')?.namedChildren[0];
        const decl = node.parent?.type === 'variable_declarator' ? node.parent : null;
        if (arg && (arg.type === 'string' || arg.type === 'template_string') && decl) {
          const module = arg.text.replace(/^['"`]|['"`]$/g, '');
          const target = decl.childForFieldName('name');
          const names: { imported: string; local: string }[] = [];
          if (target?.type === 'identifier') names.push({ imported: '*', local: target.text });
          else if (target?.type === 'object_pattern') {
            for (const p of target.namedChildren) {
              if (p.type === 'shorthand_property_identifier_pattern') names.push({ imported: p.text, local: p.text });
              else if (p.type === 'pair_pattern') {
                names.push({ imported: p.childForFieldName('key')?.text ?? '', local: p.childForFieldName('value')?.text ?? '' });
              }
            }
          }
          facts.imports.push({ line: node.startPosition.row + 1, module, names });
        }
      }
    }

    const imp = importsOf(node, spec);
    if (imp) facts.imports.push(imp);

    for (const c of node.namedChildren) visit(c);
    if (pushedDef) defStack.pop();
    if (pushedClass) classStack.pop();
  };

  try {
    visit(tree.rootNode);
    facts.syntaxErrors = tree.rootNode.hasError();
    if (spec.id === 'python') moduleNamesPython(tree.rootNode, facts);
    else if (spec.id === 'typescript' || spec.id === 'tsx' || spec.id === 'javascript') moduleNamesJs(tree.rootNode, facts);
  } catch (e) {
    facts.parseError = String(e);
  } finally {
    tree.delete();
  }
  return facts;
}

function patternNames(n: SyntaxNode, out: string[]) {
  if (IDENT_TYPES.has(n.type) || n.type === 'shorthand_property_identifier_pattern') out.push(n.text);
  else for (const c of n.namedChildren) if (c.type !== 'type_annotation' && c.type !== 'default_value') patternNames(c.childForFieldName('value') && c.type === 'pair_pattern' ? c.childForFieldName('value')! : c, out);
}

function moduleNamesPython(root: SyntaxNode, facts: FileFacts) {
  const names = new Set<string>();
  let wildcard = false;
  const visitBlock = (block: SyntaxNode, depth: number) => {
    for (const c of block.namedChildren) {
      let n = c;
      if (n.type === 'decorated_definition') n = n.childForFieldName('definition') ?? n;
      if (n.type === 'function_definition' || n.type === 'class_definition') {
        const nm = n.childForFieldName('name')?.text;
        if (nm) names.add(nm);
        if (nm === '__getattr__') wildcard = true;
      } else if (n.type === 'expression_statement') {
        for (const a of n.namedChildren) {
          if (a.type === 'assignment' || a.type === 'augmented_assignment') {
            const left = a.childForFieldName('left');
            if (left) {
              const out: string[] = [];
              patternNames(left, out);
              out.forEach((x) => names.add(x));
            }
          }
        }
      } else if (n.type === 'import_from_statement' || n.type === 'import_statement') {
        if (n.namedChildren.some((k) => k.type === 'wildcard_import')) wildcard = true;
        for (const k of n.namedChildren) {
          const modNode = n.childForFieldName('module_name');
          if (modNode && k.startIndex === modNode.startIndex) continue;
          if (k.type === 'dotted_name') names.add(k.text.split('.')[0]);
          else if (k.type === 'aliased_import') names.add(k.childForFieldName('alias')?.text ?? k.text);
        }
      } else if (depth < 2 && /^(if|try|with|for|while)_statement$/.test(n.type)) {
        for (const k of n.namedChildren) {
          if (k.type === 'block') visitBlock(k, depth + 1);
          else for (const b of k.namedChildren) if (b.type === 'block') visitBlock(b, depth + 1);
        }
      } else if (n.type === 'global_statement') {
        n.namedChildren.forEach((k) => names.add(k.text));
      }
    }
  };
  visitBlock(root, 0);
  // Anything that writes to globals() or sys.modules can define names we can't see.
  if (/\bglobals\(\)\s*\[|\bglobals\(\)\.update|sys\.modules\[/.test(root.text)) wildcard = true;
  facts.names = [...names];
  facts.wildcard = wildcard;
}

function moduleNamesJs(root: SyntaxNode, facts: FileFacts) {
  const names = new Set<string>();
  let wildcard = false;
  for (const c of root.namedChildren) {
    if (c.type === 'export_statement') {
      const decl = c.childForFieldName('declaration');
      const text = c.text;
      if (/^export\s+default\b/.test(text)) names.add('default');
      if (/^export\s*\*/.test(text) || /^export\s*=/.test(text)) wildcard = true;
      if (decl) {
        // `export declare ...` wraps the real declaration.
        const real = decl.type === 'ambient_declaration' ? decl.namedChildren[0] ?? decl : decl;
        const nm = real.childForFieldName('name')?.text;
        if (nm) names.add(nm);
        let declarators = 0;
        for (const d of real.namedChildren) {
          if (d.type === 'variable_declarator') {
            declarators++;
            const out: string[] = [];
            patternNames(d.childForFieldName('name')!, out);
            out.forEach((x) => names.add(x));
          }
        }
        // An export shape we don't understand means we can't prove a name is missing.
        if (!nm && !declarators) wildcard = true;
      }
      for (const k of c.namedChildren) {
        if (k.type === 'export_clause') {
          for (const sp of k.namedChildren) {
            if (sp.type === 'export_specifier') names.add(sp.childForFieldName('alias')?.text ?? sp.childForFieldName('name')?.text ?? sp.text);
          }
        } else if (k.type === 'namespace_export') {
          const id = k.namedChildren.find((x) => x.type === 'identifier');
          if (id) names.add(id.text);
        }
      }
    } else if (c.type === 'ambient_declaration' || c.type === 'module' || c.type === 'internal_module') {
      wildcard = true;
    } else if (c.type === 'expression_statement' && /^(module\.exports|exports\.)/.test(c.text)) {
      wildcard = true;
    }
  }
  facts.names = [...names];
  facts.wildcard = wildcard;
}

/** Line-based fallback for grammars that can't load (currently Ruby). */
function regexFacts(spec: LangSpec, source: string): FileFacts {
  const facts: FileFacts = { lang: spec.id, defs: [], calls: [], imports: [] };
  const lines = source.split('\n');
  const classStack: { name: string; indent: number }[] = [];
  lines.forEach((text, i) => {
    const indent = text.search(/\S/);
    while (classStack.length && indent >= 0 && indent <= classStack[classStack.length - 1].indent && /^\s*end\b/.test(text)) classStack.pop();
    const cls = text.match(/^\s*(class|module)\s+([A-Z]\w*(?:::\w+)*)/);
    if (cls) {
      classStack.push({ name: cls[2], indent });
      facts.defs.push({ name: cls[2], kind: 'class', line: i + 1, endLine: i + 1, params: null, signature: text.trim(), exported: true });
      return;
    }
    const def = text.match(/^\s*def\s+(self\.)?([a-z_]\w*[?!=]?)\s*(?:\(([^)]*)\)|\s+(.*))?/);
    if (def) {
      const raw = (def[3] ?? def[4] ?? '').trim();
      const params: Param[] = raw
        ? raw.split(',').map((p) => {
            const t = p.trim();
            return {
              name: t.replace(/^[*&]+/, '').replace(/[:=].*$/, '').trim(),
              optional: /=|:\s*\S/.test(t) || t.startsWith('&'),
              variadic: t.startsWith('*'),
            };
          })
        : [];
      facts.defs.push({
        name: def[2],
        kind: classStack.length ? 'method' : 'function',
        line: i + 1,
        endLine: i + 1,
        container: classStack[classStack.length - 1]?.name,
        params,
        signature: text.trim(),
        exported: true,
      });
    }
    const req = text.match(/^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/);
    if (req) facts.imports.push({ line: i + 1, module: req[1], names: [{ imported: '*', local: '*' }] });
  });
  return facts;
}

export function supportedLanguages(): string[] {
  return LANGS.map((l) => l.id);
}
