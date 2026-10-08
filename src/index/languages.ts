// Language table. Node-type names come from each tree-sitter grammar.

export interface LangSpec {
  id: string;
  wasm: string | null; // null = regex fallback only
  exts: string[];
  /** Nodes that define a named callable or type. */
  defs: Record<string, 'function' | 'method' | 'class'>;
  /** Nodes that are call sites. */
  calls: string[];
  /** Nodes that hold a parameter list (field name `parameters` unless noted). */
  paramsField: string;
  /** Parameter node types that are optional (have a default). */
  optionalParams: string[];
  /** Parameter node types that are variadic. */
  variadicParams: string[];
  /** Parameter names that are implicit receivers and should not count. */
  receiverNames: string[];
  testPath: RegExp;
}

const TEST_COMMON = /(^|\/)(__tests__|tests?|spec|specs)\/|[._-](test|spec)\.[a-z]+$|_test\.go$|Test\.java$|Tests?\.cs$/i;

export const LANGS: LangSpec[] = [
  {
    id: 'typescript',
    wasm: 'tree-sitter-typescript.wasm',
    exts: ['.ts', '.mts', '.cts'],
    defs: {
      function_declaration: 'function',
      generator_function_declaration: 'function',
      function_signature: 'function',
      method_definition: 'method',
      method_signature: 'method',
      class_declaration: 'class',
      abstract_class_declaration: 'class',
      interface_declaration: 'class',
    },
    calls: ['call_expression', 'new_expression'],
    paramsField: 'parameters',
    optionalParams: ['optional_parameter'],
    variadicParams: ['rest_pattern'],
    receiverNames: ['this'],
    testPath: TEST_COMMON,
  },
  {
    id: 'tsx',
    wasm: 'tree-sitter-tsx.wasm',
    exts: ['.tsx'],
    defs: {
      function_declaration: 'function',
      generator_function_declaration: 'function',
      method_definition: 'method',
      class_declaration: 'class',
      abstract_class_declaration: 'class',
      interface_declaration: 'class',
    },
    calls: ['call_expression', 'new_expression'],
    paramsField: 'parameters',
    optionalParams: ['optional_parameter'],
    variadicParams: ['rest_pattern'],
    receiverNames: ['this'],
    testPath: TEST_COMMON,
  },
  {
    id: 'javascript',
    wasm: 'tree-sitter-javascript.wasm',
    exts: ['.js', '.mjs', '.cjs', '.jsx'],
    defs: {
      function_declaration: 'function',
      generator_function_declaration: 'function',
      method_definition: 'method',
      class_declaration: 'class',
    },
    calls: ['call_expression', 'new_expression'],
    paramsField: 'parameters',
    optionalParams: ['assignment_pattern'],
    variadicParams: ['rest_pattern'],
    receiverNames: [],
    testPath: TEST_COMMON,
  },
  {
    id: 'python',
    wasm: 'tree-sitter-python.wasm',
    exts: ['.py', '.pyi'],
    defs: { function_definition: 'function', class_definition: 'class' },
    calls: ['call'],
    paramsField: 'parameters',
    optionalParams: ['default_parameter', 'typed_default_parameter'],
    variadicParams: ['list_splat_pattern', 'dictionary_splat_pattern'],
    receiverNames: ['self', 'cls'],
    testPath: /(^|\/)tests?\/|(^|\/)test_[^/]+\.py$|_test\.py$|conftest\.py$/,
  },
  {
    id: 'go',
    wasm: 'tree-sitter-go.wasm',
    exts: ['.go'],
    defs: { function_declaration: 'function', method_declaration: 'method', type_spec: 'class' },
    calls: ['call_expression'],
    paramsField: 'parameters',
    optionalParams: [],
    variadicParams: ['variadic_parameter_declaration'],
    receiverNames: [],
    testPath: /_test\.go$/,
  },
  {
    id: 'java',
    wasm: 'tree-sitter-java.wasm',
    exts: ['.java'],
    defs: {
      method_declaration: 'method',
      constructor_declaration: 'method',
      class_declaration: 'class',
      interface_declaration: 'class',
      record_declaration: 'class',
      enum_declaration: 'class',
    },
    calls: ['method_invocation', 'object_creation_expression'],
    paramsField: 'parameters',
    optionalParams: [],
    variadicParams: ['spread_parameter'],
    receiverNames: [],
    testPath: /(^|\/)src\/test\/|Test\.java$|Tests\.java$/,
  },
  {
    id: 'kotlin',
    wasm: 'tree-sitter-kotlin.wasm',
    exts: ['.kt', '.kts'],
    defs: { function_declaration: 'function', class_declaration: 'class', object_declaration: 'class' },
    calls: ['call_expression'],
    paramsField: 'function_value_parameters',
    optionalParams: [],
    variadicParams: [],
    receiverNames: [],
    testPath: /(^|\/)src\/test\/|Test\.kt$/,
  },
  {
    id: 'rust',
    wasm: 'tree-sitter-rust.wasm',
    exts: ['.rs'],
    defs: { function_item: 'function', function_signature_item: 'function', struct_item: 'class', enum_item: 'class', trait_item: 'class' },
    calls: ['call_expression'],
    paramsField: 'parameters',
    optionalParams: [],
    variadicParams: ['variadic_parameter'],
    receiverNames: ['self'],
    testPath: /(^|\/)tests\/|_test\.rs$/,
  },
  {
    id: 'csharp',
    wasm: 'tree-sitter-c_sharp.wasm',
    exts: ['.cs'],
    defs: {
      method_declaration: 'method',
      constructor_declaration: 'method',
      local_function_statement: 'function',
      class_declaration: 'class',
      interface_declaration: 'class',
      record_declaration: 'class',
      struct_declaration: 'class',
    },
    calls: ['invocation_expression', 'object_creation_expression'],
    paramsField: 'parameters',
    optionalParams: [],
    variadicParams: [],
    receiverNames: [],
    testPath: /Tests?\.cs$|(^|\/)tests?\//i,
  },
  {
    id: 'php',
    wasm: 'tree-sitter-php.wasm',
    exts: ['.php'],
    defs: { function_definition: 'function', method_declaration: 'method', class_declaration: 'class', interface_declaration: 'class' },
    calls: ['function_call_expression', 'member_call_expression', 'scoped_call_expression', 'object_creation_expression'],
    paramsField: 'parameters',
    optionalParams: [],
    variadicParams: ['variadic_parameter'],
    receiverNames: [],
    testPath: /Test\.php$|(^|\/)tests?\//,
  },
  {
    id: 'c',
    wasm: 'tree-sitter-c.wasm',
    exts: ['.c', '.h'],
    defs: { function_definition: 'function', struct_specifier: 'class' },
    calls: ['call_expression'],
    paramsField: 'parameters',
    optionalParams: [],
    variadicParams: ['variadic_parameter'],
    receiverNames: [],
    testPath: /(^|\/)tests?\/|_test\.c$/,
  },
  {
    id: 'cpp',
    wasm: 'tree-sitter-cpp.wasm',
    exts: ['.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx'],
    defs: { function_definition: 'function', class_specifier: 'class', struct_specifier: 'class' },
    calls: ['call_expression'],
    paramsField: 'parameters',
    optionalParams: ['optional_parameter_declaration'],
    variadicParams: ['variadic_parameter_declaration'],
    receiverNames: [],
    testPath: /(^|\/)tests?\/|_test\.cc$|_test\.cpp$/,
  },
  {
    id: 'swift',
    wasm: 'tree-sitter-swift.wasm',
    exts: ['.swift'],
    defs: { function_declaration: 'function', class_declaration: 'class', protocol_declaration: 'class' },
    calls: ['call_expression'],
    paramsField: 'parameters',
    optionalParams: [],
    variadicParams: [],
    receiverNames: [],
    testPath: /Tests?\.swift$|(^|\/)Tests\//,
  },
  {
    id: 'scala',
    wasm: 'tree-sitter-scala.wasm',
    exts: ['.scala'],
    defs: { function_definition: 'function', class_definition: 'class', object_definition: 'class', trait_definition: 'class' },
    calls: ['call_expression'],
    paramsField: 'parameters',
    optionalParams: [],
    variadicParams: [],
    receiverNames: [],
    testPath: /(^|\/)src\/test\/|Spec\.scala$|Test\.scala$/,
  },
  {
    // The bundled Ruby grammar's external scanner crashes under web-tree-sitter,
    // so Ruby uses the line-based fallback extractor.
    id: 'ruby',
    wasm: null,
    exts: ['.rb'],
    defs: {},
    calls: [],
    paramsField: 'parameters',
    optionalParams: [],
    variadicParams: [],
    receiverNames: [],
    testPath: /_spec\.rb$|_test\.rb$|(^|\/)(spec|test)\//,
  },
];

const BY_EXT = new Map<string, LangSpec>();
for (const l of LANGS) for (const e of l.exts) BY_EXT.set(e, l);

export function langFor(path: string): LangSpec | undefined {
  const m = path.match(/(\.[A-Za-z0-9]+)$/);
  return m ? BY_EXT.get(m[1].toLowerCase()) : undefined;
}

export function isTestPath(path: string): boolean {
  const l = langFor(path);
  return (l ? l.testPath : TEST_COMMON).test(path);
}

/** Generated, vendored or lock files that never deserve review comments. */
export const DEFAULT_IGNORES = [
  '**/node_modules/**',
  '**/vendor/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/coverage/**',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/*.lock',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/go.sum',
  '**/Cargo.lock',
  '**/poetry.lock',
  '**/*.generated.*',
  '**/*_pb2.py',
  '**/*.pb.go',
  '**/__snapshots__/**',
  '**/*.snap',
];
