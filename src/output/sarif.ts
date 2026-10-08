// SARIF 2.1.0 so findings show up in GitHub code scanning, GitLab, Azure DevOps
// and any IDE with a SARIF viewer.

import type { ReviewResult } from '../review/pipeline.js';

const LEVEL = { P0: 'error', P1: 'warning', P2: 'note' } as const;
const SEC_SEVERITY = { P0: '9.0', P1: '6.0', P2: '3.0' } as const;

export function renderSarif(r: ReviewResult): string {
  const rules = new Map<string, { id: string; name: string; shortDescription: { text: string }; properties: Record<string, unknown> }>();
  for (const f of r.findings) {
    if (!rules.has(f.rule)) {
      rules.set(f.rule, {
        id: f.rule,
        name: f.rule.replace(/[^A-Za-z0-9]+(.)/g, (_, c: string) => c.toUpperCase()),
        shortDescription: { text: f.rule },
        properties: { tags: [f.category, f.source], ...(f.category === 'security' || f.category === 'secret' ? { 'security-severity': SEC_SEVERITY[f.severity] } : {}) },
      });
    }
  }
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'plumb', version: r.meta.version, informationUri: 'https://github.com/plumb-review/plumb', rules: [...rules.values()] } },
        results: r.findings.map((f) => ({
          ruleId: f.rule,
          level: LEVEL[f.severity],
          message: { text: `${f.title}\n\n${f.body}` },
          locations: [{ physicalLocation: { artifactLocation: { uri: f.file }, region: { startLine: f.line, endLine: f.endLine ?? f.line } } }],
          relatedLocations: f.evidence.map((e, i) => ({
            id: i + 1,
            message: { text: e.note },
            physicalLocation: { artifactLocation: { uri: e.file }, region: { startLine: e.line } },
          })),
          partialFingerprints: { plumbFingerprint: f.id },
          properties: { severity: f.severity, verification: f.verification, confidence: f.confidence },
          ...(f.suggestion
            ? {
                fixes: [
                  {
                    description: { text: 'Suggested fix' },
                    artifactChanges: [
                      {
                        artifactLocation: { uri: f.file },
                        replacements: [{ deletedRegion: { startLine: f.line, endLine: f.endLine ?? f.line }, insertedContent: { text: f.suggestion + '\n' } }],
                      },
                    ],
                  },
                ],
              }
            : {}),
        })),
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}
