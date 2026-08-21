/**
 * Publication safety for agent reasoning.
 *
 * Reasoning text is LLM output derived from third-party web pages, so it is the
 * one place in Mimir where untrusted content is shown to users as product copy.
 * Four distinct risks, each handled here rather than hoped away:
 *
 *   1. Prompt injection — a fetched page telling the model to ignore its rules.
 *      Publishing that text verbatim would also serve the injection to whoever
 *      reads the feed and to any agent that buys the reasoning.
 *   2. Personal data — a name, email, phone or address swept in from a source.
 *   3. Unsafe links — the summary is not a place to render arbitrary URLs.
 *   4. Long verbatim quotes — a copyright problem, and a sign the model is
 *      reproducing the source rather than reasoning about it.
 *
 * A tripped check WITHHOLDS the event rather than publishing a scrubbed version:
 * a partially-redacted rationale is not trustworthy, and silently altering an
 * agent's stated reasoning is worse than showing nothing.
 */

/** Injection phrasings that should never appear in published copy. */
const INJECTION_PATTERNS: Array<[string, RegExp]> = [
  ["instruction-override", /\b(ignore|disregard|forget)\b[^.]{0,40}\b(previous|prior|above|earlier|all)\b[^.]{0,20}\b(instruction|prompt|rule|direction)/i],
  ["role-reassignment", /\b(you are now|from now on,? you|act as if you|pretend to be)\b/i],
  ["system-prompt-probe", /\b(system prompt|your instructions|reveal your (prompt|instructions|rules))\b/i],
  ["tool-command", /\b(execute|run|eval)\b[^.]{0,20}\b(command|shell|code|script)\b/i],
  ["exfiltration", /\b(send|post|upload)\b[^.]{0,30}\b(private key|secret|api key|credential)/i],
  ["fenced-directive", /```[\s\S]*\b(ignore|system|assistant)\b[\s\S]*```/i],
];

/** Personal data that must not be republished. */
const PII_PATTERNS: Array<[string, RegExp]> = [
  ["email", /[\w.+-]+@[\w-]+\.[\w.]{2,}/],
  ["phone", /(?:\+\d{1,3}[\s-]?)?(?:\(\d{2,4}\)[\s-]?)?\d{3,4}[\s-]\d{3,4}[\s-]?\d{0,4}/],
  ["iban", /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/],
  ["credit-card", /\b(?:\d[ -]?){13,19}\b/],
];

/** Only http(s) is renderable; everything else is a vector. */
const UNSAFE_URL_SCHEME = /\b(javascript|data|vbscript|file|blob):/i;
const PRIVATE_HOST =
  /\b(localhost|127\.0\.0\.1|0\.0\.0\.0|169\.254\.169\.254|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)\b/i;

/**
 * Longest run of quoted text allowed. Beyond this the model is reproducing the
 * source, which is both a copyright risk and not analysis.
 */
export const MAX_QUOTE_CHARS = 220;

export interface SafetyFinding {
  rule: string;
  detail: string;
}

export interface SafetyResult {
  safe: boolean;
  findings: SafetyFinding[];
}

function longestQuote(text: string): number {
  let longest = 0;
  // Straight and typographic double quotes.
  for (const match of text.matchAll(/["“]([^"”]{1,2000})["”]/g)) {
    longest = Math.max(longest, match[1].length);
  }
  return longest;
}

/**
 * Check one piece of publishable text. Returns every finding rather than the
 * first, so an operator sees the whole picture in the audit log.
 */
export function checkPublishableText(text: string): SafetyResult {
  const findings: SafetyFinding[] = [];

  for (const [rule, pattern] of INJECTION_PATTERNS) {
    if (pattern.test(text)) findings.push({ rule: `injection:${rule}`, detail: "injection phrasing" });
  }
  for (const [rule, pattern] of PII_PATTERNS) {
    if (pattern.test(text)) findings.push({ rule: `pii:${rule}`, detail: "possible personal data" });
  }
  if (UNSAFE_URL_SCHEME.test(text)) {
    findings.push({ rule: "url:unsafe-scheme", detail: "non-http(s) URL scheme" });
  }
  if (PRIVATE_HOST.test(text)) {
    findings.push({ rule: "url:private-host", detail: "private or metadata host" });
  }
  const quote = longestQuote(text);
  if (quote > MAX_QUOTE_CHARS) {
    findings.push({ rule: "quote:too-long", detail: `${quote} chars quoted` });
  }

  return { safe: findings.length === 0, findings };
}

/** Evidence URLs are shown to users, so they get the same scheme/host checks. */
export function checkEvidenceUrl(url: string): SafetyResult {
  const findings: SafetyFinding[] = [];
  if (!/^https?:\/\//i.test(url)) {
    findings.push({ rule: "url:unsafe-scheme", detail: "evidence URL is not http(s)" });
  }
  if (PRIVATE_HOST.test(url)) {
    findings.push({ rule: "url:private-host", detail: "evidence URL points at a private host" });
  }
  if (UNSAFE_URL_SCHEME.test(url)) {
    findings.push({ rule: "url:unsafe-scheme", detail: "embedded unsafe scheme" });
  }
  return { safe: findings.length === 0, findings };
}

export interface PublishDecision {
  visibility: "public" | "withheld";
  findings: SafetyFinding[];
}

/**
 * Decide whether a reasoning event may be published. Withholds on any finding —
 * see the module header for why a scrubbed rationale is not an acceptable
 * fallback.
 */
export function decidePublication(event: {
  summary: string;
  uncertainty: string;
  evidenceRefs: Array<{ url: string }>;
}): PublishDecision {
  const findings: SafetyFinding[] = [
    ...checkPublishableText(event.summary).findings,
    ...checkPublishableText(event.uncertainty).findings,
    ...event.evidenceRefs.flatMap((ref) => checkEvidenceUrl(ref.url).findings),
  ];
  return { visibility: findings.length === 0 ? "public" : "withheld", findings };
}
