// MCP server: lets Claude Code, Cursor, Codex or any MCP client review the
// working tree, query the code graph and read findings, all locally.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { repoRoot, Snapshot, type DiffMode } from './git.js';
import { RepoIndex } from './index/graph.js';
import { learnFromDismissal, loadMemory, saveMemory } from './memory.js';
import { fixPrompt } from './output/markdown.js';
import { runReview, VERSION, type ReviewResult } from './review/pipeline.js';

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}

export async function startMcp(): Promise<void> {
  const server = new McpServer({ name: 'plumb', version: VERSION });

  server.registerTool(
    'plumb_review',
    {
      description:
        'Review code changes in the current git repo. Static checks (broken callers, removed exports still imported, leaked secrets, blast radius) are free; set useModel to also run the model reviewer configured in .plumb/config.json within its budget.',
      inputSchema: {
        mode: z.enum(['working', 'staged', 'branch']).default('working').describe('working = all uncommitted changes; branch = current branch vs base'),
        base: z.string().optional().describe('base branch for mode=branch'),
        paths: z.array(z.string()).optional(),
        useModel: z.boolean().default(false),
      },
    },
    async ({ mode, base, paths, useModel }) => {
      const m: DiffMode = mode === 'branch' ? { kind: 'branch', base, includeUncommitted: true } : mode === 'staged' ? { kind: 'staged' } : { kind: 'working' };
      const r = await runReview({ cwd: process.cwd(), mode: m, paths, staticOnly: !useModel, confirmSpend: async () => useModel });
      const lines = [
        `Score ${r.score.score}/5 (${r.score.verdict}). ${r.findings.length} finding(s). Risk ${r.history.riskLevel}.`,
        ...r.findings.map((f) => `- [${f.severity}] ${f.file}:${f.line} ${f.title} (id ${f.id}, ${f.verification})\n  ${f.body}${f.evidence.length ? `\n  evidence: ${f.evidence.map((e) => `${e.file}:${e.line} ${e.note}`).join('; ')}` : ''}`),
        r.impact.reach.length ? `Files outside the change that call changed code: ${r.impact.reach.join(', ')}` : '',
        ...r.notes,
      ];
      return text(lines.filter(Boolean).join('\n'));
    },
  );

  server.registerTool(
    'plumb_impact',
    {
      description: 'List every caller of a function or method, using the repo code graph. Use before changing a signature.',
      inputSchema: { symbol: z.string().describe('function or method name'), file: z.string().optional().describe('file that defines it, to disambiguate') },
    },
    async ({ symbol, file }) => {
      const root = repoRoot(process.cwd());
      const idx = await RepoIndex.build(new Snapshot(root, null), { cacheDir: join(root, '.plumb', 'cache') });
      const defs = idx.allDefs(symbol).filter((d) => !file || d.file === file);
      if (!defs.length) return text(`No definition of ${symbol} found.`);
      const out: string[] = [];
      for (const d of defs) {
        const callers = idx.callersOf(d.file, symbol, 0.5);
        out.push(`${symbol} at ${d.file}:${d.def.line} (${d.def.signature}): ${callers.length} caller(s)`);
        for (const c of callers.slice(0, 50)) out.push(`  ${c.file}:${c.call.line} (${c.via})`);
      }
      return text(out.join('\n'));
    },
  );

  server.registerTool(
    'plumb_findings',
    { description: 'Get the findings from the most recent Plumb review as a fix-ready prompt.', inputSchema: {} },
    async () => {
      const root = repoRoot(process.cwd());
      const p = join(root, '.plumb', 'state', 'last.json');
      if (!existsSync(p)) return text('No review yet. Call plumb_review first.');
      const r = JSON.parse(readFileSync(p, 'utf8')) as ReviewResult;
      return text(r.findings.length ? fixPrompt(r.findings) : 'The last review found nothing.');
    },
  );

  server.registerTool(
    'plumb_dismiss',
    {
      description: 'Record that a finding is not a problem for this team. Saved as a visible rule in .plumb/memory.json.',
      inputSchema: { id: z.string(), reason: z.string().optional() },
    },
    async ({ id, reason }) => {
      const root = repoRoot(process.cwd());
      const p = join(root, '.plumb', 'state', 'last.json');
      if (!existsSync(p)) return text('No review yet.');
      const r = JSON.parse(readFileSync(p, 'utf8')) as ReviewResult;
      const f = r.findings.find((x) => x.id.startsWith(id));
      if (!f) return text(`No finding ${id} in the last review.`);
      const mem = loadMemory(root);
      const res = learnFromDismissal(mem, f, { reason });
      if (res.refused) return text(res.refused);
      saveMemory(root, mem);
      return text(`Saved rule ${res.rule.id}: ${res.rule.text}`);
    },
  );

  await server.connect(new StdioServerTransport());
}
