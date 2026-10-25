import { describe, expect, it } from "vitest";
import { csvAdapter, parseCsv } from "./csv";
import { DEFAULT_IMPORT_LIMITS, type ImportLimits } from "./types";

const ok = (text: string, limits?: ImportLimits) => { const r = parseCsv(text, limits); if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`); return r.table; };
const err = (text: string, limits?: ImportLimits) => { const r = parseCsv(text, limits); return r.ok ? "OK" : r.error.code; };
const lim = (over: Partial<ImportLimits>): ImportLimits => ({ ...DEFAULT_IMPORT_LIMITS, ...over });

describe("strict CSV parsing: accepted forms", () => {
  it("plain rows, with line numbers", () => {
    const t = ok("a,b\n1,2\n3,4\n");
    expect(t.columns).toEqual(["a", "b"]);
    expect(t.rows).toEqual([{ line: 2, cells: ["1", "2"] }, { line: 3, cells: ["3", "4"] }]);
  });
  it("CRLF line endings, no final line break, and one trailing line break", () => {
    expect(ok("a,b\r\n1,2\r\n").rows).toEqual([{ line: 2, cells: ["1", "2"] }]);
    expect(ok("a,b\n1,2").rows).toEqual([{ line: 2, cells: ["1", "2"] }]);
    expect(ok("a,b\n1,2\n").rows).toHaveLength(1);
  });
  it("quoted fields with commas, doubled quotes and line breaks", () => {
    const t = ok('a,b,c\n"x, y","say ""hi""","line1\nline2"\nnext,row,here\n');
    expect(t.rows[0]!.cells).toEqual(["x, y", 'say "hi"', "line1\nline2"]);
    expect(t.rows[1]).toEqual({ line: 4, cells: ["next", "row", "here"] }); // physical line numbering survives a multi-line field
  });
  it("a quoted empty string, an unquoted empty field and trailing commas", () => {
    expect(ok('a,b,c\n"",,\n').rows[0]!.cells).toEqual(["", "", ""]);
    expect(ok("a,b\n1,\n").rows[0]!.cells).toEqual(["1", ""]);
  });
  it("one leading BOM is ignored", () => {
    expect(ok("﻿a,b\n1,2\n").columns).toEqual(["a", "b"]);
  });
  it("unicode is preserved", () => {
    expect(ok("a,b\n日本語,€ naïve\n").rows[0]!.cells).toEqual(["日本語", "€ naïve"]);
  });
  it("a row with the wrong number of cells is returned as it is (the importer rejects that one row)", () => {
    expect(ok("a,b\n1,2,3\n4\n").rows.map((r) => r.cells.length)).toEqual([3, 1]);
  });
  it("header only", () => expect(ok("a,b\n").rows).toEqual([]));
  it("is a SourceAdapter", () => { expect(csvAdapter.id).toBe("csv"); expect(csvAdapter.read("a\n1\n", DEFAULT_IMPORT_LIMITS)).toEqual(parseCsv("a\n1\n")); });
});

describe("strict CSV parsing: malformed input is refused with a closed code", () => {
  it.each([
    ["empty input", "", "empty_input"],
    ["only a BOM", "﻿", "empty_input"],
    ["an unterminated quote", 'a,b\n"x,2\n', "unterminated_quote"],
    ["an unterminated quote at the very end", 'a,b\n1,"', "unterminated_quote"],
    ["a quote inside an unquoted field", 'a,b\n1,x"y\n', "stray_quote"],
    ["text after a closing quote", 'a,b\n"x"y,2\n', "stray_quote"],
    ["a quote after a closing quote and a space", 'a,b\n"x" ,2\n', "stray_quote"],
    ["a bare CR", "a,b\n1,2\r3,4\n", "invalid_line_ending"],
    ["a CR at the end", "a,b\n1,2\r", "invalid_line_ending"],
    ["a NUL character", "a,b\n1,\u00002\n", "invalid_character"],
    ["a NUL inside quotes", 'a,b\n1,"x\u0000y"\n', "invalid_character"],
    ["a blank header", ",\n1,2\n", "missing_header"],
    ["an all-blank header row", "\n1,2\n", "missing_header"],
  ])("%s", (_n, text, code) => expect(err(text)).toBe(code));
  it("reports the line of the problem, never the text", () => {
    const r = parseCsv('a,b\n1,2\n3,x"y\n');
    expect(r).toEqual({ ok: false, error: { code: "stray_quote", line: 3 } });
    expect(JSON.stringify(parseCsv('a,b\n"SECRET-VALUE\n'))).not.toContain("SECRET");
  });
  it("non-string input is unreadable, not a crash", () => {
    for (const x of [null, undefined, 5, {}, ["a"]]) expect(err(x as never)).toBe("source_unreadable");
  });
});

describe("import size and resource limits", () => {
  it("bytes: counted in UTF-8, not characters", () => {
    expect(err("a\n1\n", lim({ maxBytes: 4 }))).toBe("OK");
    expect(err("a\n1\n", lim({ maxBytes: 3 }))).toBe("input_too_large");
    expect(err("a\n€€€\n", lim({ maxBytes: 8 }))).toBe("input_too_large"); // 6 characters but 11 bytes
  });
  it("rows: the limit counts data rows, not the header", () => {
    const rows = (n: number) => "a\n" + Array.from({ length: n }, (_, i) => String(i)).join("\n") + "\n";
    expect(err(rows(5), lim({ maxRows: 5 }))).toBe("OK");
    expect(err(rows(6), lim({ maxRows: 5 }))).toBe("too_many_rows");
  });
  it("columns, in the header and in a row", () => {
    expect(err("a,b,c\n1,2,3\n", lim({ maxColumns: 3 }))).toBe("OK");
    expect(err("a,b,c,d\n1,2,3,4\n", lim({ maxColumns: 3 }))).toBe("too_many_columns");
    expect(err("a,b\n1,2,3,4\n", lim({ maxColumns: 3 }))).toBe("too_many_columns");
  });
  it("field length, quoted and unquoted", () => {
    expect(err("a\n" + "x".repeat(10) + "\n", lim({ maxFieldChars: 10 }))).toBe("OK");
    expect(err("a\n" + "x".repeat(11) + "\n", lim({ maxFieldChars: 10 }))).toBe("field_too_long");
    expect(err('a\n"' + "x".repeat(11) + '"\n', lim({ maxFieldChars: 10 }))).toBe("field_too_long");
  });
  it("defaults are enforced and a hostile huge input is cut off quickly without being parsed", () => {
    const big = "a\n" + "1\n".repeat(600_000);
    const t0 = Date.now();
    expect(err(big)).toBe("input_too_large");
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it("a long run of quotes or commas cannot hang the parser", () => {
    const t0 = Date.now();
    err('a\n"' + '""'.repeat(200_000) + '"\n', lim({ maxBytes: 10_000_000, maxFieldChars: 1_000_000 }));
    err("a" + ",".repeat(100_000) + "\n", lim({ maxBytes: 10_000_000 }));
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe("robustness", () => {
  it("is deterministic", () => {
    const text = 'a,b\n"1,5",2\n3,"x ""y"""\n';
    expect(parseCsv(text)).toEqual(parseCsv(text));
  });
  it("round-trips any table through a reference writer", () => {
    const quote = (s: string) => (/[",\r\n]/.test(s) || s === "" ? `"${s.replace(/"/g, '""')}"` : s);
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const alphabet = ['a', 'b', ' ', ',', '"', '\n', 'é', '日', '1', ';'];
    for (let t = 0; t < 200; t++) {
      const cols = 1 + Math.floor(rnd() * 4), rows = Math.floor(rnd() * 5);
      const cell = () => Array.from({ length: Math.floor(rnd() * 6) }, () => alphabet[Math.floor(rnd() * alphabet.length)]!).join("");
      const header = Array.from({ length: cols }, (_, i) => `h${i}`);
      const body = Array.from({ length: rows }, () => Array.from({ length: cols }, cell));
      const text = [header, ...body].map((r) => r.map(quote).join(",")).join("\n") + "\n";
      const parsed = ok(text);
      expect(parsed.rows.map((r) => r.cells), text).toEqual(body);
    }
  });
  it("never throws, whatever the input (fuzz)", () => {
    let seed = 99;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) & 0x7fffffff) / 0x7fffffff;
    const alphabet = ['"', ",", "\n", "\r", "a", "1", " ", "\u0000", "﻿", "é", "\\"];
    for (let t = 0; t < 2000; t++) {
      const s = Array.from({ length: Math.floor(rnd() * 40) }, () => alphabet[Math.floor(rnd() * alphabet.length)]!).join("");
      expect(() => parseCsv(s)).not.toThrow();
    }
  });
});
