// Shared types. Everything Plumb produces is plain data so it can be
// rendered to the terminal, Markdown, SARIF, HTML or JSON without loss.

export type Severity = 'P0' | 'P1' | 'P2';

export type Category =
  | 'logic'
  | 'security'
  | 'contract'
  | 'secret'
  | 'performance'
  | 'concurrency'
  | 'data'
  | 'syntax'
  | 'style'
  | 'test';

/** How a finding earned its place in the review. */
export type Verification =
  | 'deterministic' // proven by static analysis, no model involved
  | 'confirmed' // a model raised it and an independent skeptic pass failed to refute it
  | 'unverified' // raised by a model, verification skipped or inconclusive
  | 'refuted'; // the skeptic pass disproved it (kept only in --show-refuted mode)

export interface Evidence {
  file: string;
  line: number;
  /** Real source text read from disk, never model-written. */
  snippet: string;
  note: string;
}

export interface Finding {
  /** Stable fingerprint, survives line shifts between runs. */
  id: string;
  source: 'static' | 'llm';
  rule: string;
  severity: Severity;
  category: Category;
  file: string;
  line: number;
  endLine?: number;
  title: string;
  body: string;
  evidence: Evidence[];
  /** Replacement text for lines [line, endLine]. */
  suggestion?: string;
  confidence: number;
  verification: Verification;
  verifierNote?: string;
  /** Present when a memory rule changed this finding. */
  memory?: { ruleId: string; action: 'downgraded' | 'suppressed' };
  /** Incremental status relative to the previous review of this branch. */
  status?: 'new' | 'open' | 'fixed';
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffLine {
  type: 'add' | 'del' | 'ctx';
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

export interface FileChange {
  path: string;
  oldPath?: string;
  status: FileStatus;
  binary: boolean;
  hunks: Hunk[];
  /** New-side line numbers that were added or changed. */
  added: Set<number>;
  /** Old-side line numbers that were removed. */
  removed: Set<number>;
}

export interface CostEstimate {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  note?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  usd: number;
  calls: number;
}
