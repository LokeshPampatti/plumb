import { afterEach, describe, expect, it } from 'vitest';
import { agentSafetyFindings } from '../src/analyzers/agentsafety.js';
import type { AnalysisContext } from '../src/analyzers/context.js';
import { loadConfig } from '../src/config.js';
import { collectChanges } from '../src/git.js';
import { RepoIndex } from '../src/index/graph.js';
import { tempRepo, type TempRepo } from './helpers.js';

let repo: TempRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

async function findingsFor(files: Record<string, string>) {
  repo = tempRepo();
  repo.write({ 'README.md': 'x\n' });
  repo.commit('init');
  repo.write(files);
  const changes = collectChanges(repo.root, { kind: 'working' });
  const ctx: AnalysisContext = {
    changes,
    newIndex: await RepoIndex.build(changes.newSnap),
    oldIndex: await RepoIndex.partial(changes.oldSnap, []),
    loaded: loadConfig(changes.oldSnap, changes.newSnap),
    reviewFiles: new Set(changes.files.map((f) => f.path)),
  };
  return agentSafetyFindings(ctx);
}

describe('agent safety', () => {
  it('flags each risky pattern once, all P1, with the real line as evidence', async () => {
    const f = await findingsFor({
      'src/agent.ts': [
        "const client = new OpenAI({ apiKey, dangerouslyAllowBrowser: true });",
        "const system = `You are a helper. Summarize: ${req.body.text}`;",
        "execSync(completion.choices[0].message.content);",
        "el.innerHTML = aiResponse;",
        "db.query(`SELECT * FROM t WHERE ${modelOutput}`);",
        '',
      ].join('\n'),
      'agent.py': 'agent = create_pandas_dataframe_agent(llm, df, allow_dangerous_code=True)\n',
    });
    const rules = f.map((x) => x.rule).sort();
    expect(rules).toEqual([
      'agent/dangerous-flag',
      'agent/dangerous-flag',
      'agent/model-output-executed',
      'agent/model-output-html',
      'agent/model-output-sql',
      'agent/untrusted-in-prompt',
    ]);
    expect(f.every((x) => x.severity === 'P1')).toBe(true);
    expect(f.find((x) => x.rule === 'agent/model-output-executed')!.evidence[0].snippet).toContain('execSync(');
  });

  it('stays quiet on safe code, comments and tests', async () => {
    const f = await findingsFor({
      'src/safe.ts': [
        "const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: req.body.text }];",
        "el.textContent = aiResponse;",
        "// execSync(completion) would be bad",
        "db.query('SELECT * FROM t WHERE id = $1', [modelOutput.id]);",
        "execSync('git status');",
        '',
      ].join('\n'),
      'test/agent.test.ts': 'execSync(completion);\n',
    });
    expect(f).toEqual([]);
  });
});
