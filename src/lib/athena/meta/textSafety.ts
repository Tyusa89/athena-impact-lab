// Model text is DATA to read, never something to open, run or follow. This module finds the shapes of text that invite a reader (or a downstream renderer) to leave the
// analysis: links, markup, code and shell/database commands. Pure and client-safe. Text is normalized first (NFKC, invisible characters removed, whitespace around `:` and `/`
// collapsed) so width variants, zero-width insertions and "ht tp : //" spacing do not hide a link. A hit REJECTS the output (never rewritten) and the error names a category only,
// never the text. It is a bounded heuristic for business prose: it does not claim to catch every encoding, and React escaping remains the rendering defence.
import { INVISIBLE_CHARS } from "./grounding";

export const UNSAFE_KINDS = ["link", "email", "markup", "code", "command"] as const;
export type UnsafeKind = (typeof UNSAFE_KINDS)[number];

const TLDS = "com|org|net|io|ai|dev|app|co|xyz|info|biz|gov|edu|me|us|uk|de|ru|cn|tk|ly|sh|cc|to|site|online|top|click|link|zip|mov";
const RULES: { kind: UnsafeKind; re: RegExp }[] = [
  { kind: "link", re: /\b[a-z][a-z0-9+.-]{1,15}:\/\// },
  { kind: "link", re: /\b(?:https?|ftp|file|data|javascript|vbscript|mailto|tel|sms|ssh|ws|wss|blob)\s*:/ },
  { kind: "link", re: /\bhxxps?\b/ },
  { kind: "link", re: /\bwww\s*\./ },
  { kind: "link", re: new RegExp(`\\b[a-z0-9][a-z0-9-]*\\.(?:${TLDS})\\b`) },
  { kind: "link", re: new RegExp(`\\b[a-z0-9][a-z0-9-]*\\s*(?:\\[\\.\\]|\\(\\.\\)|\\[dot\\]|\\(dot\\)|\\sdot\\s)\\s*(?:${TLDS})\\b`) },
  { kind: "link", re: /\[[^\]]*\]\s*\([^)]*\)/ }, // markdown link or image
  { kind: "link", re: /^\s*\[[^\]]+\]:\s*\S+/m }, // markdown reference definition
  { kind: "email", re: /\b[a-z0-9._%+-]+\s*(?:@|\[at\]|\(at\))\s*[a-z0-9-]+(?:\s*(?:\.|\[dot\]|\(dot\))\s*[a-z0-9-]+)+/ },
  { kind: "markup", re: /<\s*\/?\s*[a-z!?][^>]*>?/ },
  { kind: "markup", re: /&(?:#x?[0-9a-f]+|[a-z]{2,8});/ },
  { kind: "code", re: /`/ },
  { kind: "code", re: /~{3}/ },
  { kind: "code", re: /[{}]/ },
  { kind: "code", re: /\$\s*[({]|\$[a-z_][a-z0-9_]*\b|%\s*[a-z_]+\s*%/ },
  { kind: "code", re: /\b(?:eval|exec|system|require|import|function|console\.log|document\.|window\.|process\.|__proto__)\b\s*[(.]/ },
  { kind: "code", re: /\b(?:def|class|lambda|var|let|const)\s+[a-z_]\w*\s*(?:=|\(|:)/ },
  { kind: "code", re: /=>|\+\+|--\s*[a-z]|\/\*|\*\/|<<|>>/ },
  { kind: "command", re: /\|\||&&|(?:^|\s)\|(?:\s|$)|;\s*(?:rm|curl|wget|sudo|cat|ls|cd|chmod|bash|sh|python|node|npm|pip|git)\b/ },
  { kind: "command", re: /(?:^|[\s;&|(])(?:sudo|curl|wget|chmod|chown|rm\s+-|rm\s+\/|mkdir|rmdir|kill|killall|nc|netcat|nmap|ssh|scp|powershell|cmd\.exe|bash|zsh|sh\s+-c|python3?|node|perl|ruby|php|docker|kubectl|systemctl|crontab|apt(?:-get)?|yum|brew|git\s+(?:clone|push|pull|checkout|reset)|npm\s+(?:i|install|run|exec)|npx|yarn\s+(?:add|run)|pip3?\s+install)\s+[-./~\w]/ },
  { kind: "command", re: /\b(?:select\s+[\w*,\s]+\s+from|insert\s+into|update\s+\w+\s+set|delete\s+from|drop\s+(?:table|database|schema)|truncate\s+table|alter\s+table|create\s+(?:table|user)|grant\s+all|union\s+select)\b/ },
  { kind: "command", re: /(?:^|\s)(?:~\/|\/(?:etc|usr|var|bin|tmp|home|root|proc|dev)\/|[a-z]:\\|\\\\)/ },
];

/** Normalized form scanned by the rules: width variants folded, invisible characters removed, spaces around `:` `/` `.` collapsed, lower-cased. */
export function scanText(text: string): string {
  return text.normalize("NFKC").replace(INVISIBLE_CHARS, "").replace(/\s*([:/])\s*/g, "$1").replace(/[ \t]+/g, " ").toLowerCase();
}

/** The categories of unsafe content found in model text (empty when none). Never returns the matched text. */
export function unsafeTextKinds(text: string): UnsafeKind[] {
  const raw = text.normalize("NFKC").replace(INVISIBLE_CHARS, "").toLowerCase();
  const t = scanText(text);
  // letter-spaced schemes ("h t t p s : / / host"): whitespace removed, scheme separator required
  const compact = raw.replace(/\s+/g, "");
  const found = new Set<UnsafeKind>();
  for (const r of RULES) if (r.re.test(raw) || r.re.test(t)) found.add(r.kind);
  if (/(?:https?|ftp|file|wss?|ssh):\/\//.test(compact)) found.add("link");
  return UNSAFE_KINDS.filter((k) => found.has(k));
}

/** Fixed wording for a rejection: a category-free sentence, so the response cannot be used to probe which rule fired or to echo what the model wrote. */
export const UNSAFE_MESSAGE = (where: string) => `Unsafe content: ${where} contains a link, markup, code or a command; model text must be plain prose`;
