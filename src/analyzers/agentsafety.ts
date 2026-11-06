// Agent-safety checks on added lines: the ways LLM features turn untrusted
// text into actions. Pattern matches, not proofs, so nothing here is P0 and
// every finding says what to check. No model involved.

import { isTestPath } from '../index/languages.js';
import type { Finding } from '../types.js';
import { finalize, type AnalysisContext } from './context.js';

// Text that came from outside: a request, a webhook, a scraped page, an email.
const UNTRUSTED =
  /\b(req|request)\.(body|query|params|headers)\b|\bevent\.body\b|\brequest\.(json|form|args|get_json)\b|\b(userInput|user_input|untrusted|scraped|pageText|page_text|emailBody|email_body|html|webContent|web_content|fileContents|file_contents)\b/;
// Text that came from a model.
const MODEL_OUTPUT =
  /\b(completion|choices\[\d\]|output_text|outputText|tool_?[cC]all[s]?|toolInput|tool_input|function_call|llm(Result|Output|Response)?|modelOutput|model_output|aiResponse|ai_response|generated(Code|Sql|Command)?)\b|\bmessage\.content\b|\bresponse\.(text|content)\b/;
const PROMPT_BUILD =
  /\b(prompt|system|system_?[pP]rompt|systemMessage|instructions)\s*[:=+]|role\s*:\s*['"](system|user)['"]|\{\s*["']role["']\s*:/;
const INTERP = /\$\{[^}]*\}|\bf["'][^"']*\{[^}]+\}|["']\s*\+\s*\w|\.format\(/;
const RUNS_CODE =
  /\b(exec|execSync|spawn|spawnSync|eval|new Function|os\.system|subprocess\.(run|call|Popen|check_output)|child_process|vm\.runIn\w+Context)\s*\(/;
const RUNS_SQL = /\.(query|execute|raw|\$queryRawUnsafe|\$executeRawUnsafe)\s*\(/;
const RENDERS_HTML = /\binnerHTML\s*=|dangerouslySetInnerHTML|\bv-html\b|\|\s*safe\b|\bmark_safe\(/;
const DANGER_FLAGS: Array<[RegExp, string]> = [
  [/dangerouslyAllowBrowser\s*:\s*true/, '`dangerouslyAllowBrowser: true` ships the model API key to every visitor'],
  [/allow_dangerous_code\s*=\s*True/, '`allow_dangerous_code=True` lets the agent run model-written Python'],
  [/allow_dangerous_requests\s*=\s*True/, '`allow_dangerous_requests=True` lets the agent make arbitrary HTTP requests'],
  [/trust_remote_code\s*=\s*True/, '`trust_remote_code=True` runs code downloaded with the model'],
  [/--dangerously-skip-permissions\b/, '`--dangerously-skip-permissions` lets a coding agent run any command without asking'],
];

type Hit = { id: string; title: string; body: string; note: string };

function check(text: string): Hit | null {
  for (const [re, why] of DANGER_FLAGS) {
    if (re.test(text)) return { id: 'dangerous-flag', title: 'Agent safety switch turned off', body: `On this line, ${why}. Keep it off unless the input is fully trusted, and say why in a comment if it has to stay.`, note: 'added line' };
  }
  if (MODEL_OUTPUT.test(text) && RUNS_CODE.test(text)) {
    return { id: 'model-output-executed', title: 'Model output is passed straight to code execution', body: 'A model can be steered by text it reads (prompt injection), so anything it writes should be treated like user input. Run it only against an allowlist of commands, in a sandbox, or after a human approves it.', note: 'model output reaches exec/eval' };
  }
  if (MODEL_OUTPUT.test(text) && RUNS_SQL.test(text) && INTERP.test(text)) {
    return { id: 'model-output-sql', title: 'Model-written text is built into a SQL query', body: 'Use parameters and a read-only role for anything a model generates; injected instructions can make it write a destructive query.', note: 'model output interpolated into SQL' };
  }
  if (MODEL_OUTPUT.test(text) && RENDERS_HTML.test(text)) {
    return { id: 'model-output-html', title: 'Model output is rendered as raw HTML', body: 'If the model ever repeats attacker text, this becomes stored XSS. Render it as text or sanitize it first.', note: 'model output rendered unescaped' };
  }
  if (PROMPT_BUILD.test(text) && UNTRUSTED.test(text) && INTERP.test(text)) {
    return { id: 'untrusted-in-prompt', title: 'Untrusted input is pasted into the prompt as instructions', body: 'Text from a request, page or email can carry instructions of its own. Put it in a separate, clearly delimited user or data message, never in the system prompt, and keep tool permissions narrow for this call.', note: 'untrusted text interpolated into a prompt' };
  }
  return null;
}

export function agentSafetyFindings(ctx: AnalysisContext): Finding[] {
  const out: Finding[] = [];
  const snap = ctx.changes.newSnap;
  for (const fc of ctx.changes.files) {
    if (fc.binary || fc.status === 'deleted' || isTestPath(fc.path) || /fixture|mock|example|sample|\.md$/i.test(fc.path)) continue;
    for (const h of fc.hunks) {
      for (const l of h.lines) {
        if (l.type !== 'add' || l.newNo === undefined || l.text.length > 1000) continue;
        if (/^\s*(\/\/|#|\*|\/\*)/.test(l.text)) continue;
        const hit = check(l.text);
        if (!hit) continue;
        out.push(
          finalize(
            {
              source: 'static',
              rule: `agent/${hit.id}`,
              severity: 'P1',
              category: 'security',
              file: fc.path,
              line: l.newNo,
              title: hit.title,
              body: `${hit.body} (Pattern match on this line; check how the value is produced before acting on it.)`,
              evidence: [{ file: fc.path, line: l.newNo, snippet: l.text.trim().slice(0, 200), note: hit.note }],
              confidence: hit.id === 'dangerous-flag' ? 0.9 : 0.6,
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
