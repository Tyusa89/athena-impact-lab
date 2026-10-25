// The analysis question: UNTRUSTED text that may arrive with a request. Pure. Validation is structural and strict, and it is a first line of defence only:
// a question is placed in a fixed slot of the prompt as data, and nothing it says can widen what the model is given (the evidence is selected by
// authorization before a question is read) or what the engine accepts back (every reply is validated from scratch against the authorized facts).
// A question that names things outside the caller's scope cannot make them appear: the engine rejects model text about them (domain guard, leak check).
//
// Accepted: one line of 8-300 characters (after NFKC normalization and trimming) made only of letters, marks, digits, spaces and . , ; : ? ! ' " ( ) / % & -
// with at least two words. Rejected: anything else (line breaks, tabs, control, zero-width and bidi characters, brackets, braces, backticks, angle brackets,
// pipes, backslashes, `$`, `#`, `=` ...), and text that imitates the prompt's own structure or another role.
export const QUESTION_MIN = 8;
export const QUESTION_MAX = 300;
export const QUESTION_REJECTIONS = ["not_text", "too_short", "too_long", "bad_characters", "mimics_structure"] as const;
export type QuestionRejection = (typeof QUESTION_REJECTIONS)[number];
export type QuestionResult = { ok: true; question: string } | { ok: false; code: QuestionRejection };

const ALLOWED = /^[\p{L}\p{M}\p{N} .,;:?!'"()/%&-]+$/u;
/** Names the prompt uses for its own sections, other roles' labels, and fact-id shapes: a question may not forge them. */
const MIMICS = [/\bverified[\s_-]*facts?\b/i, /\bperiods?\s*\(\s*json\s*\)/i, /\bperiods\s*:/i, /\bquestion\s*:/i, /\b(system|assistant|developer|user|tool|human)\s*:/i, /\bfact[\s_]*id\b/i, /\bF-[A-Za-z_]/, /\bjson\b/i, /\brefs?\s*:/i];

export function validateQuestion(raw: unknown): QuestionResult {
  if (typeof raw !== "string") return { ok: false, code: "not_text" };
  if (raw.length > QUESTION_MAX * 4) return { ok: false, code: "too_long" }; // cheap bound before any normalization work
  const q = raw.normalize("NFKC").trim().replace(/ {2,}/g, " ");
  const n = [...q].length;
  if (n < QUESTION_MIN) return { ok: false, code: "too_short" };
  if (n > QUESTION_MAX) return { ok: false, code: "too_long" };
  if (!ALLOWED.test(q)) return { ok: false, code: "bad_characters" };
  if (!/\p{L}/u.test(q) || q.split(" ").filter(Boolean).length < 2) return { ok: false, code: "too_short" };
  if (MIMICS.some((re) => re.test(q))) return { ok: false, code: "mimics_structure" };
  return { ok: true, question: q };
}
