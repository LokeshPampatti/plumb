// Secret detection on added lines. Matches are always redacted in output.

import { isTestPath } from '../index/languages.js';
import type { Finding } from '../types.js';
import { finalize, type AnalysisContext } from './context.js';
import { ASSIGN_RE, looksLikeSecretValue, PATTERNS, redact } from '../redact.js';

export { redact, redactSecrets } from '../redact.js';

export function secretFindings(ctx: AnalysisContext): Finding[] {
  const out: Finding[] = [];
  const snap = ctx.changes.newSnap;
  for (const fc of ctx.changes.files) {
    if (fc.binary || fc.status === 'deleted') continue;
    const isEnvFile = /(^|\/)\.env(\.[\w-]+)?$/.test(fc.path) && !/\.(example|sample|template)$/.test(fc.path);
    const testy = isTestPath(fc.path) || /fixture|mock|example|sample/i.test(fc.path);
    let envReported = false;
    for (const h of fc.hunks) {
      for (const l of h.lines) {
        if (l.type !== 'add' || l.newNo === undefined) continue;
        const text = l.text;
        if (text.length > 2000) continue;
        let hit: { name: string; match: string; live: boolean; id: string } | null = null;
        for (const p of PATTERNS) {
          const m = text.match(p.re);
          // Documentation and test placeholders (xoxb-xxxxxxxx, AKIA...EXAMPLE) are not leaks.
          if (m && !/x{6,}|X{6,}|EXAMPLE|example|fake|dummy|placeholder|redacted|0{8,}|1234567890/.test(m[0])) {
            hit = { name: p.name, match: m[0], live: p.live, id: p.id };
            break;
          }
        }
        if (!hit) {
          const m = text.match(ASSIGN_RE);
          if (m && looksLikeSecretValue(m[1], m[2])) hit = { name: `hard-coded \`${m[1]}\``, match: m[2], live: false, id: 'assignment' };
        }
        if (!hit && isEnvFile && !envReported && /^\s*[A-Z0-9_]+\s*=\s*\S{8,}/.test(text)) {
          envReported = true;
          hit = { name: 'committed .env file', match: text.split('=').slice(1).join('=').trim(), live: true, id: 'env-file' };
        }
        if (!hit) continue;
        const sev = hit.live && !testy ? 'P0' : 'P1';
        out.push(
          finalize(
            {
              source: 'static',
              rule: `secret/${hit.id}`,
              severity: sev,
              category: 'secret',
              file: fc.path,
              line: l.newNo,
              title: `Possible ${hit.name} committed in plain text`,
              body:
                `Line ${l.newNo} adds what looks like a ${hit.name} (\`${redact(hit.match)}\`). ` +
                'Anything pushed to a remote should be treated as leaked: rotate it, then load it from an environment variable or secret manager.' +
                (testy ? ' This file looks like test data, so it may be a fake value.' : ''),
              // Evidence snippets for secrets are redacted on purpose.
              evidence: [{ file: fc.path, line: l.newNo, snippet: text.replace(hit.match, redact(hit.match)).trim().slice(0, 200), note: 'added line (value redacted)' }],
              confidence: hit.id === 'assignment' ? 0.7 : 0.9,
              verification: 'deterministic',
            },
            snap,
          ),
        );
      }
    }
  }
  return out;
}
