// Model text is DATA to read, never something to open, run or follow. This module finds the shapes of text that invite a reader (or a downstream renderer) to leave the
// analysis: links, markup, code and shell/database commands. Pure and client-safe. Text is normalized first (NFKC, invisible characters removed, whitespace around `:` and `/`
// collapsed) so width variants, zero-width insertions and "ht tp : //" spacing do not hide a link. A hit REJECTS the output (never rewritten) and the error names a category only,
// never the text. It is a bounded heuristic for business prose: it does not claim to catch every encoding, and React escaping remains the rendering defence.
import { INVISIBLE_CHARS } from "./grounding";

export const UNSAFE_KINDS = ["link", "email", "markup", "code", "command"] as const;
export type UnsafeKind = (typeof UNSAFE_KINDS)[number];

const TLDS = "com|org|net|io|ai|dev|app|co|xyz|info|biz|gov|edu|me|us|uk|de|ru|cn|tk|ly|sh|cc|to|site|online|top|click|link|zip|mov";
// Words that are ordinary English as well as tool names. They count as a command only in COMMAND FORM: followed by a flag (`-x`, `--x`), a path (`./x`, `/x`, `~/x`, `c:\`),
// a script file (`x.py`), or one of the tool's own subcommands. "kill the campaign" and "each node of the chain" are prose; "kill -9 job", "node server.js" and
// "git push origin" are commands. Words that are almost never prose (sudo, curl, wget, chmod, ...) are commands with ANY argument.
const SUBCOMMANDS: Record<string, string> = {
  git: "clone|push|pull|checkout|reset|commit|rebase|merge|fetch|add|remote|config|stash|init",
  npm: "install|i|ci|run|exec|start|test|publish|uninstall|update|link",
  yarn: "add|install|run|remove|global",
  pip: "install|uninstall|download", pip3: "install|uninstall|download",
  apt: "install|remove|purge|update|upgrade|autoremove", "apt-get": "install|remove|purge|update|upgrade|autoremove",
  brew: "install|uninstall|tap|upgrade|update|cask", yum: "install|remove|update",
  docker: "run|exec|build|pull|push|compose|rm|rmi|stop|start|ps|images|login|kill",
  kubectl: "get|apply|delete|exec|create|describe|port-forward|config",
  systemctl: "start|stop|restart|enable|disable|status|daemon-reload",
};
const AMBIGUOUS = "kill|killall|node|nc|apt|apt-get|brew|yum|ruby|perl|php|python3?|docker|kubectl|systemctl|ssh|sh|bash|zsh|cd|ls|cat|git|npm|yarn|pip3?";
const UNAMBIGUOUS = "sudo|curl|wget|chmod|chown|mkdir|rmdir|nmap|netcat|scp|powershell|cmd\\.exe|crontab|npx";
const BOUND = "(?:^|[\\s;&|(`$>])"; // a command starts a line or follows a separator, a prompt or a space
const FLAG_OR_PATH = "\\s+(?:--?[a-z0-9]|\\.{0,2}[\\\\/]|~[\\\\/]|[a-z]:\\\\)";
const SCRIPT_ARG = "\\s+[\\w./-]+\\.(?:py|js|mjs|cjs|ts|sh|rb|pl|php|exe|bat|ps1|jar)\\b";
const subcommandRules = Object.entries(SUBCOMMANDS).map(([tool, subs]) => `${tool.replace("-", "\\-")}\\s+(?:${subs})\\b`).join("|");
// Colon forms that are URIs only when a payload follows the colon (`tel:+155`, `file:///x`, `data:text/html`), not when prose such as "Missing data: lead source" does.
const URI_PAYLOAD = [
  "(?:https?|ftp)\\s*:", // these are links however they are written
  "(?:javascript|vbscript)\\s*:", // script schemes: never prose
  "(?:mailto|blob)\\s*:\\s*\\S",
  "(?:tel|sms)\\s*:\\s*[+(]?\\d",
  "file\\s*:\\s*(?:[\\\\/]|[a-z]:)",
  "data\\s*:\\s*(?:(?:text|application|image|audio|video|multipart|font|message|model)/[a-z0-9.+-]+)",
  "data\\s*:(?:;|,)",
].join("|");

/** Rules tested against the scanned text (whitespace around `:` and `/` collapsed) and the unmodified normalized text. */
const RULES: { kind: UnsafeKind; re: RegExp }[] = [
  { kind: "link", re: /\b[a-z][a-z0-9+.-]{1,15}:\/\// },
  { kind: "link", re: /\bhxxps?\b/ },
  { kind: "link", re: /\bwww\s*\./ },
  { kind: "link", re: new RegExp(`\\b[a-z0-9][a-z0-9-]*\\.(?:${TLDS})\\b`) },
  { kind: "link", re: new RegExp(`\\b[a-z0-9][a-z0-9-]*\\s*(?:\\[\\.\\]|\\(\\.\\)|\\[dot\\]|\\(dot\\))\\s*(?:${TLDS})\\b`) },
  // "evil dot com" is a hostname written out; "the dot com era" and "a dot com company" are English. A label that is an article, preposition or determiner is not a host label.
  { kind: "link", re: new RegExp(`\\b(?!(?:the|a|an|of|and|or|in|on|to|for|with|this|that|these|those|our|their|its|any|every|each|no)\\s+dot\\b)[a-z0-9][a-z0-9-]*\\s+dot\\s+(?:${TLDS})\\b`) },
  { kind: "link", re: /\[[^\]]*\]\s*\([^)]*\)/ }, // markdown link or image
  { kind: "link", re: /^\s*\[[^\]]+\]:\s*\S+/m }, // markdown reference definition
  { kind: "email", re: /\b[a-z0-9._%+-]+\s*(?:@|\[at\]|\(at\))\s*[a-z0-9-]+(?:\s*(?:\.|\[dot\]|\(dot\))\s*[a-z0-9-]+)+/ },
  // markup: a real tag (`<b>`, `</p>`, `<a href="x">`), a comment or declaration, or any of the dangerous tag names even if unclosed. A spaced comparison ("cost < revenue") is not a tag.
  { kind: "markup", re: /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/ },
  { kind: "markup", re: /<(?:!|\?|\/?\s*(?:script|iframe|object|embed|style|link|meta|img|svg|form|input|button|body|html|base|video|audio|math|template|a)\b)/ },
  { kind: "markup", re: /&(?:#x?[0-9a-f]+|[a-z]{2,8});/ },
  { kind: "code", re: /`/ },
  { kind: "code", re: /~{3}/ },
  { kind: "code", re: /[{}]/ },
  { kind: "code", re: /\$\s*[({]|\$[a-z_][a-z0-9_]*\b|%\s*[a-z_]+\s*%/ },
  // calls and property access: `eval (x)`, `system(x)`, `process.env`. "the billing system (CRM)", "the exec (CEO)" and "the sales process." are prose.
  { kind: "code", re: /\b(?:eval|require)\s*\(|\b(?:exec|system|import|function)\(|\bconsole\.[a-z_]+\s*\(|\b(?:document|window|process)\.[a-z_]\w*|__proto__/ },
  { kind: "code", re: /\b(?:def|class|lambda|var|let|const)\s+[a-z_]\w*\s*(?:=|\(|:)/ },
  // `--flag` attached to a word is an option; a spaced dash ("paid social -- especially") is punctuation.
  { kind: "code", re: /=>|\+\+|(?:^|\s)--[a-z]|\/\*|\*\/|<<|>>/ },
  { kind: "command", re: /\|\||&&|(?:^|\s)\|(?:\s|$)|;\s*(?:rm|curl|wget|sudo|chmod|bash)\b/ },
  { kind: "command", re: new RegExp(`${BOUND}(?:${UNAMBIGUOUS})\\s+[-./~\\w]`) },
  { kind: "command", re: new RegExp(`${BOUND}rm\\s+[-/]`) },
  { kind: "command", re: new RegExp(`${BOUND}(?:${AMBIGUOUS})(?:${FLAG_OR_PATH}|${SCRIPT_ARG})`) },
  { kind: "command", re: new RegExp(`${BOUND}(?:${subcommandRules})`) },
  { kind: "command", re: /\b(?:select\s+[\w*,\s]+\s+from|insert\s+into|update\s+\w+\s+set|delete\s+from|drop\s+(?:table|database|schema)|truncate\s+table|alter\s+table|create\s+(?:table|user)|grant\s+all|union\s+select)\b/ },
  { kind: "command", re: /(?:^|\s)(?:~\/|\/(?:etc|usr|var|bin|tmp|home|root|proc|dev)\/|[a-z]:\\|\\\\)/ },
];
/** Rules tested only against the normalized text with its original spacing (the scanned form would turn "data: lead source" into "data:lead source"). */
const RAW_RULES: { kind: UnsafeKind; re: RegExp }[] = [
  { kind: "link", re: new RegExp(`\\b(?:${URI_PAYLOAD})`) },
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
  for (const r of RAW_RULES) if (r.re.test(raw)) found.add(r.kind);
  if (/(?:https?|ftp|file|wss?|ssh):\/\//.test(compact)) found.add("link");
  return UNSAFE_KINDS.filter((k) => found.has(k));
}

/** Fixed wording for a rejection: a category-free sentence, so the response cannot be used to probe which rule fired or to echo what the model wrote. */
export const UNSAFE_MESSAGE = (where: string) => `Unsafe content: ${where} contains a link, markup, code or a command; model text must be plain prose`;
