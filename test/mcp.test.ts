import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempRepo, type TempRepo } from './helpers.js';

let repo: TempRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

describe('MCP server', () => {
  it('lists tools and runs a static review over stdio', async () => {
    repo = tempRepo();
    repo.write({
      'src/a.ts': `export function f(x: number) { return x; }\n`,
      'src/b.ts': `import { f } from './a';\nexport const y = f(1);\n`,
    });
    repo.commit('init');
    repo.write({ 'src/a.ts': `export function f(x: number, y: number) { return x + y; }\n` });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(__dirname, '..', 'src', 'cli.ts'), 'mcp'],
      cwd: repo.root,
      stderr: 'ignore',
    });
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual(['plumb_dismiss', 'plumb_findings', 'plumb_impact', 'plumb_review']);
      const r = (await client.callTool({ name: 'plumb_review', arguments: { mode: 'working' } })) as { content: { text: string }[] };
      expect(r.content[0].text).toContain('now takes 2 arguments');
      expect(r.content[0].text).toContain('src/b.ts');
      const imp = (await client.callTool({ name: 'plumb_impact', arguments: { symbol: 'f' } })) as { content: { text: string }[] };
      expect(imp.content[0].text).toContain('src/b.ts:2');
    } finally {
      await client.close();
    }
  }, 30000);
});
