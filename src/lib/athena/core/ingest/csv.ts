// Strict CSV reader. A SourceAdapter<string>. Pure and deterministic; never throws on malformed input, never echoes input text in errors.
//
// Accepted: comma delimiter; quoted fields with embedded commas, line breaks and doubled quotes ("" = one quote); LF or CRLF; one optional leading BOM;
// a single trailing line break. Refused as structural errors: an unterminated quote, a quote inside an unquoted field or text after a closing quote,
// a bare CR, NUL, anything over the limits, no header, an empty input. Rows whose field count differs from the header are returned with
// their real cell count so the importer can reject exactly that row.
import { DEFAULT_IMPORT_LIMITS, type ImportLimits, type RawRow, type SourceAdapter, type SourceReadResult, type StructuralCode } from "./types";

const fail = (code: StructuralCode, line?: number): SourceReadResult => (line === undefined ? { ok: false, error: { code } } : { ok: false, error: { code, line } });

export function parseCsv(input: string, limits: ImportLimits = DEFAULT_IMPORT_LIMITS): SourceReadResult {
  if (typeof input !== "string") return fail("source_unreadable");
  if (input.length === 0) return fail("empty_input");
  if (input.length > limits.maxBytes || new TextEncoder().encode(input).length > limits.maxBytes) return fail("input_too_large");
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (text.length === 0) return fail("empty_input");

  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let line = 1; // physical line of the current position
  let recordLine = 1; // physical line where the current record began
  let i = 0;
  const n = text.length;

  for (;;) {
    let field = "";
    if (text[i] === '"') {
      i++;
      for (;;) {
        if (i >= n) return fail("unterminated_quote", recordLine);
        const ch = text[i]!;
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; } else { i++; break; }
        } else {
          if (ch === "\u0000") return fail("invalid_character", line);
          if (ch === "\n") line++;
          field += ch;
          i++;
        }
        if (field.length > limits.maxFieldChars) return fail("field_too_long", recordLine);
      }
      const after = text[i];
      if (after !== undefined && after !== "," && after !== "\n" && after !== "\r") return fail("stray_quote", line); // text after a closing quote
    } else {
      while (i < n && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") {
        const ch = text[i]!;
        if (ch === '"') return fail("stray_quote", line); // a quote inside an unquoted field
        if (ch === "\u0000") return fail("invalid_character", line);
        field += ch;
        i++;
        if (field.length > limits.maxFieldChars) return fail("field_too_long", recordLine);
      }
    }
    cells.push(field);
    if (cells.length > limits.maxColumns) return fail("too_many_columns", recordLine);
    const ch = text[i];
    if (ch === ",") { i++; continue; } // next field (a trailing comma yields a final empty field)
    records.push({ line: recordLine, cells });
    cells = [];
    if (records.length > limits.maxRows + 1) return fail("too_many_rows", recordLine);
    if (ch === undefined) break; // end of input without a final line break
    if (ch === "\r") {
      if (text[i + 1] !== "\n") return fail("invalid_line_ending", line); // a bare CR
      i += 2;
    } else {
      i++;
    }
    line++;
    recordLine = line;
    if (i >= n) break; // a single trailing line break ends the input
  }

  const header = records[0]!.cells;
  if (header.every((h) => h.trim() === "")) return fail("missing_header", records[0]!.line);
  const rows: RawRow[] = records.slice(1).map((r) => ({ line: r.line, cells: r.cells }));
  return { ok: true, table: { columns: header, rows } };
}

export const csvAdapter: SourceAdapter<string> = { id: "csv", read: parseCsv };
