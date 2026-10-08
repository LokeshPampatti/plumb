// Secret patterns and redaction, shared by detection, display and model prompts.

export interface Pattern {
  id: string;
  name: string;
  re: RegExp;
  /** Live production credential (P0) vs. something that may be a test value (P1). */
  live: boolean;
}

export const PATTERNS: Pattern[] = [
  { id: 'aws-access-key', name: 'AWS access key ID', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, live: true },
  { id: 'aws-secret', name: 'AWS secret access key', re: /aws.{0,20}?(secret|private).{0,20}?['"][A-Za-z0-9/+=]{40}['"]/i, live: true },
  { id: 'github-token', name: 'GitHub token', re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/, live: true },
  { id: 'slack-token', name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, live: true },
  { id: 'slack-webhook', name: 'Slack webhook URL', re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/, live: true },
  { id: 'stripe-live', name: 'Stripe live secret key', re: /\b(sk|rk)_live_[0-9A-Za-z]{20,}\b/, live: true },
  { id: 'stripe-test', name: 'Stripe test secret key', re: /\bsk_test_[0-9A-Za-z]{20,}\b/, live: false },
  { id: 'anthropic-key', name: 'Anthropic API key', re: /\bsk-ant-(api|admin)\d{2}-[A-Za-z0-9_-]{40,}\b/, live: true },
  { id: 'openai-key', name: 'OpenAI API key', re: /\bsk-(proj-)?[A-Za-z0-9_-]{40,}\b/, live: true },
  { id: 'google-api-key', name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/, live: true },
  { id: 'private-key', name: 'private key block', re: /-----BEGIN ((RSA|EC|DSA|OPENSSH|PGP|ENCRYPTED) )?PRIVATE KEY( BLOCK)?-----/, live: true },
  { id: 'twilio', name: 'Twilio API key', re: /\bSK[0-9a-f]{32}\b/, live: true },
  { id: 'sendgrid', name: 'SendGrid API key', re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/, live: true },
  { id: 'resend', name: 'Resend API key', re: /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}\b/, live: true },
  { id: 'supabase-service', name: 'Supabase service-role JWT', re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]*cm9sZSI6InNlcnZpY2Vfcm9sZS[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{10,}/, live: true },
  { id: 'db-url-password', name: 'database URL with a password', re: /\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis|amqp):\/\/[^:\s/'"]+:[^@\s'"]{6,}@[^\s'"]+/, live: true },
];

// `password = "hunter2"`-style assignments with a high-entropy literal.
export const ASSIGN_RE = /\b([A-Za-z_]*(?:secret|token|passwd|password|api_?key|apikey|private_?key|client_?secret|auth)[A-Za-z_]*)\s*[:=]\s*['"]([^'"\s]{12,})['"]/i;
export const PLACEHOLDER = /^(x+|.*x{6,}|.*X{6,}|.*(fake|dummy|example|sample|placeholder|redacted|changeme).*|\*+|changeme|change_me|your[_-]|example|dummy|test|fake|placeholder|<|\$\{|process\.env|os\.environ|env\(|\{\{)/i;

export function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let e = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    e -= p * Math.log2(p);
  }
  return e;
}

export function redact(s: string): string {
  if (s.length <= 8) return '****';
  return s.slice(0, 4) + '…' + '*'.repeat(Math.min(12, s.length - 4));
}

/** Redact anything secret-shaped in a line of source before it is displayed anywhere. */
export function redactSecrets(line: string): string {
  let out = line;
  for (const p of PATTERNS) {
    const g = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g');
    out = out.replace(g, (m) => redact(m));
  }
  const m = out.match(ASSIGN_RE);
  if (m && looksLikeSecretValue(m[1], m[2])) out = out.replace(`${m[2]}`, redact(m[2]));
  return out;
}


/** Redact secret-shaped values across a multi-line block. */
export function redactBlock(text: string): string {
  return text
    .split('\n')
    .map((l) => (l.length > 2000 ? l : redactSecrets(l)))
    .join('\n');
}

/**
 * Does a string assigned to a secret-sounding name look like an actual credential?
 * Constants such as PASSWORD_PARAM = "password_param" or USER_AUTH = "USER_SET_BEFORE_AUTH" do not.
 */
export function looksLikeSecretValue(name: string, value: string): boolean {
  if (PLACEHOLDER.test(value) || entropy(value) < 3.5) return false;
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (norm(value) === norm(name) || norm(value).includes(norm(name)) || norm(name).includes(norm(value))) return false;
  // Identifier-, path- or message-shaped text: words joined by _ . - / : or spaces, no digits.
  if (/^[A-Za-z]+([_.\-/: ][A-Za-z]+)*$/.test(value)) return false;
  if (/^[a-z]+([A-Z][a-z]+)+$/.test(value)) return false; // camelCase word
  if (/^(https?:)?\/\//.test(value) && !/:[^@/\s]+@/.test(value)) return false; // URL without credentials
  const hasDigit = /\d/.test(value);
  const hasLetter = /[A-Za-z]/.test(value);
  return (hasDigit && hasLetter) || (value.length >= 32 && /[a-z]/.test(value) && /[A-Z]/.test(value));
}
