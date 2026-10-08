#!/usr/bin/env node
import { Command, Option } from 'commander';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import pc from 'picocolors';
import { DEFAULT_CONFIG, SAMPLE_CONFIG, type PlumbConfig } from './config.js';
import { repoRoot, Snapshot, type DiffMode } from './git.js';
import { RepoIndex } from './index/graph.js';
import { detectProvider } from './llm/factory.js';
import { addPreference, forget, learnFromDismissal, loadMemory, saveMemory } from './memory.js';
import { renderHtml } from './output/html.js';
import { fixPrompt, renderMarkdown } from './output/markdown.js';
import { renderSarif } from './output/sarif.js';
import { renderTerminal } from './output/terminal.js';
import { runReview, VERSION, type ReviewResult } from './review/pipeline.js';
import type { CostEstimate, Finding, Severity } from './types.js';

const program = new Command();
program.name('plumb').description('Local-first AI code review that shows its work.').version(VERSION);

function lastResult(root: string): ReviewResult | null {
  const p = join(root, '.plumb', 'state', 'last.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as ReviewResult;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const a = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return a === 'y' || a === 'yes';
}

function describeEstimate(e: CostEstimate): string {
  const tokens = `~${Math.round(e.inputTokens / 1000)}k in / ~${Math.round(e.outputTokens / 1000)}k out`;
  return e.usd > 0 ? `${e.provider}/${e.model}: ${tokens}, about $${e.usd.toFixed(2)}` : `${e.provider}/${e.model}: ${tokens}, ${e.note ?? 'free'}`;
}

program
  .command('review', { isDefault: true })
  .description('Review a change. Default: everything uncommitted (staged, unstaged and untracked) vs HEAD.')
  .argument('[paths...]', 'limit the review to these paths/globs')
  .option('--staged', 'review only staged changes')
  .option('-b, --branch [base]', 'review the current branch against base (default: the repo default branch)')
  .option('--include-uncommitted', 'with --branch: include uncommitted edits too')
  .option('--range <a..b>', 'review a commit range')
  .option('--pr <url>', 'review a GitHub pull request by URL or owner/repo#123 (no clone needed)')
  .addOption(new Option('--provider <name>', 'model provider').choices(['anthropic', 'openai', 'ollama', 'claude-code', 'none']))
  .option('--model <id>', 'model id')
  .option('--verifier-model <id>', 'model for the skeptic pass')
  .addOption(new Option('--effort <level>', 'reasoning effort').choices(['low', 'medium', 'high', 'xhigh', 'max']))
  .option('--static', 'static checks only: no model calls, $0')
  .option('--votes <n>', 'independent finder samples; keep findings a majority agree on', (v) => parseInt(v, 10))
  .option('--no-verify', 'skip the skeptic pass')
  .option('--budget <usd>', 'hard spend cap for this run', parseFloat)
  .addOption(new Option('--strictness <n>', '1 verbose, 2 balanced, 3 critical only').choices(['1', '2', '3']))
  .option('-i, --instructions <text>', 'extra instructions for this run')
  .option('-y, --yes', 'do not ask before paid model calls')
  .option('--estimate', 'print the cost estimate and stop')
  .option('--json', 'print JSON')
  .option('--md', 'print the Markdown PR summary')
  .option('--sarif <file>', 'write SARIF 2.1.0')
  .option('--html <file>', 'write a standalone HTML report')
  .option('--show-refuted', 'also list model findings the skeptic discarded')
  .option('--repro', 'write and run a failing test for each serious model finding (runs model-written code on this machine)')
  .option('--keep-repro', 'with --repro: keep the generated tests in .plumb/repro/')
  .option('--no-toolchain', "don't run tsc / go vet / ruff")
  .addOption(new Option('--fail-on <sev>', 'exit 1 if a finding at or above this severity exists').choices(['P0', 'P1', 'P2', 'none']))
  .action(async (paths: string[], o) => {
    let cwd = process.cwd();
    let prDescription: string | undefined;
    let prMode: DiffMode | null = null;
    if (o.pr) {
      const { parsePrSpec, preparePr } = await import('./remote.js');
      const spec = parsePrSpec(o.pr);
      if (!spec) throw new Error(`Not a pull request: ${o.pr}. Use a github.com/.../pull/N URL or owner/repo#N.`);
      const prep = await preparePr(spec, (m) => process.stderr.write(pc.dim(`· ${m}\n`)));
      cwd = prep.cwd;
      prMode = prep.mode;
      prDescription = `${prep.title}\n\n${prep.body}`;
      process.stderr.write(pc.dim(`· Reviewing ${prep.url} (${prep.title})\n`));
    }
    const root = repoRoot(cwd);
    let mode: DiffMode = prMode ?? { kind: 'working' };
    if (prMode) mode = prMode;
    else if (o.staged) mode = { kind: 'staged' };
    else if (o.branch !== undefined) mode = { kind: 'branch', base: typeof o.branch === 'string' ? o.branch : undefined, includeUncommitted: !!o.includeUncommitted };
    else if (o.range) {
      const [from, to] = String(o.range).split(/\.\.\.?/);
      mode = { kind: 'range', from, to: to || 'HEAD' };
    }

    const cfg: Partial<PlumbConfig> = {};
    const fileCfgPath = join(root, '.plumb', 'config.json');
    const hasFileProvider = existsSync(fileCfgPath) && /"provider"\s*:/.test(readFileSync(fileCfgPath, 'utf8'));
    const provider = o.provider ?? (hasFileProvider ? undefined : detectProvider());
    if (provider || o.model || o.effort || o.verifierModel) {
      cfg.model = { ...DEFAULT_CONFIG.model, ...(provider ? { provider } : {}), ...(o.model ? { name: o.model } : {}), ...(o.effort ? { effort: o.effort } : {}), ...(o.verifierModel ? { verifier: o.verifierModel } : {}) } as PlumbConfig['model'];
      if (!provider && hasFileProvider) delete (cfg.model as Partial<PlumbConfig['model']>).provider;
    }
    if (o.votes) cfg.votes = o.votes;
    if (o.verify === false) cfg.verify = false;
    if (o.budget !== undefined) cfg.budgetUsd = o.budget;
    if (o.strictness) cfg.strictness = Number(o.strictness) as 1 | 2 | 3;
    if (o.repro) cfg.repro = true;
    if (o.toolchain === false) cfg.toolchain = false;

    const quiet = o.json || o.md;
    const log = quiet ? () => {} : (m: string) => process.stderr.write(pc.dim(`· ${m}\n`));
    const result = await runReview({
      cwd,
      mode,
      prDescription,
      config: cfg,
      staticOnly: !!o.static,
      instructions: o.instructions,
      keepRepro: !!o.keepRepro,
      paths,
      log,
      estimateOnly: !!o.estimate,
      confirmSpend: async (e) => {
        if (o.yes) return true;
        process.stderr.write(`${pc.bold('Cost estimate')} ${describeEstimate(e)}\n`);
        if (!process.stdin.isTTY) {
          process.stderr.write(pc.yellow('Not a terminal and no --yes: skipping paid model calls.\n'));
          return false;
        }
        return confirm('Run the model review? [y/N] ');
      },
    });

    if (o.estimate) {
      process.stdout.write(result.estimate ? describeEstimate(result.estimate) + '\n' : 'No model configured; static checks are free.\n');
      return;
    }
    const src = (file: string) => new Snapshot(root, null).read(file);
    if (o.sarif) writeFileSync(o.sarif, renderSarif(result));
    if (o.html) writeFileSync(o.html, renderHtml(result, src));
    if (o.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else if (o.md) process.stdout.write(renderMarkdown(result) + '\n');
    else process.stdout.write(renderTerminal(result, { showRefuted: o.showRefuted, source: src }));
    if (o.html && !quiet) process.stderr.write(pc.dim(`HTML report: ${o.html}\n`));

    const failOn: Severity | 'none' = o.failOn ?? 'none';
    if (failOn !== 'none') {
      const rank = { P0: 0, P1: 1, P2: 2 };
      if (result.findings.some((f) => rank[f.severity] <= rank[failOn])) process.exitCode = 1;
    }
  });

program
  .command('init')
  .description('Create .plumb/ with a commented config, a rules file and a .gitignore')
  .action(() => {
    const root = repoRoot(process.cwd());
    const dir = join(root, '.plumb');
    mkdirSync(dir, { recursive: true });
    const wrote: string[] = [];
    const put = (name: string, body: string) => {
      const p = join(dir, name);
      if (existsSync(p)) return;
      writeFileSync(p, body);
      wrote.push(`.plumb/${name}`);
    };
    put('config.json', SAMPLE_CONFIG.replace('"provider": "anthropic"', `"provider": "${detectProvider() === 'none' ? 'claude-code' : detectProvider()}"`));
    put('rules.md', '# Team rules\n\nOne rule per bullet. A rules.md inside any folder\'s .plumb/ applies only to that folder.\n\n- Every API route checks the session before reading the request body.\n');
    put('memory.json', JSON.stringify({ version: 1, rules: [] }, null, 2) + '\n');
    put('.gitignore', 'cache/\nstate/\n');
    console.log(wrote.length ? `Created ${wrote.join(', ')}` : '.plumb/ already set up');
    console.log(pc.dim('Commit config.json, rules.md and memory.json so the whole team shares them.'));
  });

function findFinding(root: string, id: string): Finding | null {
  const last = lastResult(root);
  if (!last) return null;
  return [...last.findings, ...last.suppressed, ...last.refuted].find((f) => f.id === id || f.id.startsWith(id)) ?? null;
}

program
  .command('dismiss')
  .description('Teach Plumb to stop flagging something like this finding. Writes a visible rule to .plumb/memory.json.')
  .argument('<id>', 'finding id (from the last review)')
  .option('-r, --reason <text>', 'why this is not a problem for your team')
  .addOption(new Option('--scope <scope>', 'where the lesson applies').choices(['file', 'dir', 'repo']).default('dir'))
  .option('--downgrade', 'keep flagging, but as P2 instead of hiding it')
  .action((id: string, o) => {
    const root = repoRoot(process.cwd());
    const f = findFinding(root, id);
    if (!f) {
      console.error(`No finding ${id} in the last review. Run \`plumb review\` first.`);
      process.exitCode = 1;
      return;
    }
    const mem = loadMemory(root);
    const res = learnFromDismissal(mem, f, { reason: o.reason, scope: o.scope, kind: o.downgrade ? 'downgrade' : 'suppress' });
    if (res.refused) {
      console.error(pc.yellow(res.refused));
      process.exitCode = 1;
      return;
    }
    saveMemory(root, mem);
    console.log(`${res.created ? 'Learned' : 'Strengthened'} rule ${pc.bold(res.rule.id)}: ${res.rule.text}`);
    console.log(pc.dim(`Matches: ${JSON.stringify(res.rule.match)}. Takes effect on the next review. Undo: plumb memory forget ${res.rule.id}`));
  });

program
  .command('remember')
  .description('Add a team preference the reviewer should follow (e.g. "We use Result<T>, not exceptions, in src/payments")')
  .argument('<text...>')
  .action((text: string[]) => {
    const root = repoRoot(process.cwd());
    const mem = loadMemory(root);
    const r = addPreference(mem, text.join(' '));
    saveMemory(root, mem);
    console.log(`Saved preference ${pc.bold(r.id)}. It goes into every future review prompt.`);
  });

program
  .command('memory')
  .description('Show or edit what Plumb has learned')
  .argument('[action]', 'list | forget', 'list')
  .argument('[id]')
  .action((action: string, id?: string) => {
    const root = repoRoot(process.cwd());
    const mem = loadMemory(root);
    if (action === 'forget') {
      if (!id) throw new Error('Usage: plumb memory forget <id>');
      const r = forget(mem, id);
      if (!r) {
        console.error(`No memory rule ${id}`);
        process.exitCode = 1;
        return;
      }
      saveMemory(root, mem);
      console.log(`Forgot ${id}: ${r.text}`);
      return;
    }
    if (!mem.rules.length) {
      console.log('Nothing learned yet. Use `plumb dismiss <id>` or `plumb remember "<preference>"`.');
      return;
    }
    for (const r of mem.rules) {
      console.log(`${pc.bold(r.id)} ${pc.dim(r.kind)} ${r.text}`);
      if (r.kind !== 'prefer') console.log(pc.dim(`   match ${JSON.stringify(r.match)} · ${r.evidence.length} example${r.evidence.length === 1 ? '' : 's'} · hit ${r.hits ?? 0}x`));
    }
  });

program
  .command('impact')
  .description('Who calls this? Query the code graph for a symbol, a file, or file:line.')
  .argument('<target>', 'symbolName | path/to/file | path/to/file:line')
  .action(async (target: string) => {
    const root = repoRoot(process.cwd());
    const snap = new Snapshot(root, null);
    const idx = await RepoIndex.build(snap, { cacheDir: join(root, '.plumb', 'cache') });
    const m = target.match(/^(.*?):(\d+)$/);
    let targets: { file: string; name: string; line: number }[] = [];
    if (m && snap.exists(m[1])) {
      const d = idx.enclosingDef(m[1], Number(m[2]));
      if (d) targets = [{ file: m[1], name: d.name, line: d.line }];
    } else if (snap.exists(target)) {
      targets = idx.defsIn(target).filter((d) => d.kind !== 'class').map((d) => ({ file: target, name: d.name, line: d.line }));
    } else {
      targets = idx.allDefs(target).map((d) => ({ file: d.file, name: d.def.name, line: d.def.line }));
    }
    if (!targets.length) {
      console.log(`Nothing named ${target} in the index.`);
      return;
    }
    for (const t of targets) {
      const callers = idx.callersOf(t.file, t.name, 0.5);
      console.log(`${pc.bold(t.name)} ${pc.dim(`${t.file}:${t.line}`)}  ${callers.length} caller${callers.length === 1 ? '' : 's'}`);
      for (const c of callers.slice(0, 30)) console.log(`  └ ${c.file}:${c.call.line} ${pc.dim(`(${c.via}, ${Math.round(c.confidence * 100)}%)`)}`);
      const importers = idx.importersOf(t.file).length;
      if (importers) console.log(pc.dim(`  ${importers} file${importers === 1 ? '' : 's'} import ${t.file}`));
    }
  });

program
  .command('fix-prompt')
  .description('Print a prompt that hands the last review\'s findings to a coding agent (pipe into `claude`).')
  .option('--severity <sev>', 'only findings at or above this severity', 'P2')
  .action((o) => {
    const root = repoRoot(process.cwd());
    const last = lastResult(root);
    if (!last?.findings.length) {
      console.error('No findings in the last review.');
      return;
    }
    const rank = { P0: 0, P1: 1, P2: 2 } as Record<string, number>;
    process.stdout.write(fixPrompt(last.findings.filter((f) => rank[f.severity] <= rank[o.severity])) + '\n');
  });

program
  .command('fix')
  .description('Apply the suggested fixes from the last review (only where the code has not changed since)')
  .argument('[ids...]', 'finding ids (prefixes ok); default: every finding with a suggestion')
  .addOption(new Option('--severity <sev>', 'only findings at or above this severity').choices(['P0', 'P1', 'P2']).default('P2'))
  .option('--dry-run', 'show what would change without writing')
  .action(async (ids: string[], o) => {
    const { planFixes, writeFixes } = await import('./fix.js');
    const root = repoRoot(process.cwd());
    const last = lastResult(root);
    if (!last) {
      console.error('No review yet. Run `plumb review` first.');
      process.exitCode = 1;
      return;
    }
    const plan = planFixes(root, last.findings, { ids: ids.length ? ids : undefined, maxSeverity: o.severity });
    for (const a of plan.applied) {
      console.log(`${pc.green(o.dryRun ? 'would fix' : 'fixed')} ${a.finding.file}:${a.finding.line} ${pc.dim(a.finding.title)}`);
      for (const l of a.before) console.log(pc.red(`  - ${l}`));
      for (const l of a.after) console.log(pc.green(`  + ${l}`));
    }
    for (const s of plan.skipped) console.log(`${pc.yellow('skipped')} ${s.finding.file}:${s.finding.line} ${pc.dim(s.reason)}`);
    if (!plan.applied.length && !plan.skipped.length) console.log('No findings with suggested fixes.');
    if (!o.dryRun && plan.applied.length) {
      writeFixes(root, plan);
      console.log(pc.dim(`Applied ${plan.applied.length} fix(es). Run \`plumb review\` to check the result, \`git diff\` to see it.`));
    }
  });

program
  .command('hook')
  .description('Install a git pre-push hook that blocks pushes with P0 findings (static checks, $0, ~1s)')
  .argument('<action>', 'install | uninstall')
  .action((action: string) => {
    const root = repoRoot(process.cwd());
    const p = join(root, '.git', 'hooks', 'pre-push');
    const marker = '# plumb pre-push hook';
    if (action === 'uninstall') {
      if (existsSync(p) && readFileSync(p, 'utf8').includes(marker)) writeFileSync(p, '#!/bin/sh\n');
      console.log('Removed the Plumb pre-push hook.');
      return;
    }
    if (existsSync(p) && !readFileSync(p, 'utf8').includes(marker) && readFileSync(p, 'utf8').trim() !== '#!/bin/sh') {
      console.error('A different pre-push hook already exists; not overwriting it.');
      process.exitCode = 1;
      return;
    }
    writeFileSync(p, `#!/bin/sh\n${marker}\nnpx --no-install plumb review --branch --static --fail-on P0 || {\n  echo "plumb: P0 findings above. Push anyway with: git push --no-verify"\n  exit 1\n}\n`);
    chmodSync(p, 0o755);
    console.log('Installed .git/hooks/pre-push (static checks only, no model calls).');
  });

program
  .command('stats')
  .description('Review analytics from local history: addressed rate, fixed vs dismissed, by category')
  .option('--days <n>', 'look-back window', '90')
  .action(async (o) => {
    const { computeStats } = await import('./stats.js');
    const s = computeStats(repoRoot(process.cwd()), Number(o.days));
    if (!s || !s.runs) {
      console.log('No review history yet.');
      return;
    }
    const pct = (n: number | null) => (n === null ? 'n/a' : `${Math.round(n * 100)}%`);
    console.log(`${pc.bold(String(s.runs))} reviews · ${s.distinct} findings raised · ${pc.green(`${s.fixed} fixed`)} · ${s.dismissed} dismissed · ${s.open} open · $${s.usd.toFixed(2)} spent`);
    console.log(`Addressed rate ${pc.bold(pct(s.addressedRate))} (fixed out of fixed + dismissed) · ${s.refuted} model findings discarded by the skeptic before you saw them`);
    for (const c of s.byCategory) console.log(pc.dim(`  ${c.category.padEnd(12)} ${String(c.raised).padStart(4)} raised  ${String(c.fixed).padStart(4)} fixed  ${String(c.dismissed).padStart(4)} dismissed`));
  });

program
  .command('github')
  .description('Run inside GitHub Actions: review the pull request and post a summary plus inline comments')
  .action(async () => {
    const { runGithub } = await import('./github.js');
    await runGithub();
  });

program
  .command('mcp')
  .description('Start an MCP server (stdio) so Claude Code, Cursor or Codex can call Plumb')
  .action(async () => {
    const { startMcp } = await import('./mcp.js');
    await startMcp();
  });

program.parseAsync().catch((e: Error) => {
  console.error(pc.red(e.message));
  process.exitCode = 2;
});
