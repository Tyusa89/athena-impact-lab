import { describe, expect, it } from "vitest";
import type { AccessPolicy } from "../core/access";
import { authorizeDemo, demoAccessPolicy, type PrototypeEvidence } from "../prototypeAdapter";
import { PROTOTYPE_CATALOG } from "../prototypeCatalog";
import { PROTOTYPE_RUNTIME } from "./adapter.server";
import { validateAuthorizedOutput } from "./analysis";
import { buildAuthorizedFacts } from "./grounding";
import { checkSemantics, isStrictMentions, semanticScope, type SemanticScope } from "./semantic";
import { UNSAFE_MESSAGE, unsafeTextKinds } from "./textSafety";

// H1.1: (1) the strict-mention switch fails CLOSED for any unexpected value; (2) the text-safety scan separates ordinary business prose from real links, markup, code and
// commands. Pure and offline: no provider, no network.
const authorized = authorizeDemo({ scenarioId: "baseline", roleId: "finance" });
const facts = buildAuthorizedFacts(authorized.authorized, PROTOTYPE_RUNTIME.analysis);
// Scopes here carry NO facts: what the role may discover is exactly the grant, so each test states its own boundary.
const scopeWith = (strict: unknown, grant: string[] = ["revenue"]): SemanticScope => ({ ...semanticScope([], [], PROTOTYPE_CATALOG, { discoverable: grant }), strictMentions: strict as boolean });
const codes = (t: string, s: SemanticScope, lane: "interpretation" | "recommendation" | "gap" = "gap") => checkSemantics(t, lane, s, "gap 1").map((i) => i.code);

describe("strictMentions fails closed", () => {
  it.each([[undefined, false], [false, false], [true, true], ["true", true], ["false", true], ["", true], ["strict", true], [0, true], [1, true], [null, true], [NaN, true], [{}, true], [[], true], [[false], true]])(
    "isStrictMentions(%j) is %j", (v, want) => { expect(isStrictMentions(v)).toBe(want); });

  it("only undefined and exactly false leave the legacy leniency on; every other value rejects a cross-department neutral mention", () => {
    const text = "Lead volume may be worth a look.";
    expect(codes(text, scopeWith(undefined))).toEqual([]);
    expect(codes(text, scopeWith(false))).toEqual([]);
    for (const v of [true, "true", "false", "", "0", 0, 1, null, NaN, {}, [], "yes", " true "]) expect(codes(text, scopeWith(v)), JSON.stringify(v)).toEqual(["domain"]);
  });
  it("the constructor normalizes the same way, so a config-sourced value cannot relax the scope", () => {
    for (const v of ["true", "false", 1, 0, null, {}]) {
      const s = semanticScope(authorized.authorized, facts, PROTOTYPE_CATALOG, { discoverable: ["revenue"], strictMentions: v as never });
      expect(s.strictMentions, JSON.stringify(v)).toBe(true);
      expect(codes("Lead volume may be worth a look.", s)).toEqual(["domain"]);
    }
    for (const v of [undefined, false]) expect(semanticScope(authorized.authorized, facts, PROTOTYPE_CATALOG, { discoverable: ["revenue"], strictMentions: v }).strictMentions).toBe(false);
  });
  it("legacy behavior is unchanged where it is explicit: cross-department neutral mentions pass, same-department hidden mentions and directional claims still fail", () => {
    const legacy = scopeWith(false, ["leads"]);
    expect(codes("Recognized revenue may be worth a look.", legacy)).toEqual([]);
    expect(codes("Lead quality may be worth a look.", legacy)).toEqual(["domain"]); // hidden, in the role's own Marketing department
    expect(codes("Recognized revenue fell.", legacy, "interpretation")).toEqual(["domain"]);
  });
  it("a hand-built scope that omits the flag is legacy (documented), and one that omits the discoverable set still rejects everything", () => {
    const { strictMentions: _omit, ...noFlag } = scopeWith(undefined, ["leads"]);
    void _omit;
    expect(codes("Recognized revenue may be worth a look.", noFlag as SemanticScope)).toEqual([]);
    const { discoverable: _d, ...noSet } = scopeWith(false, ["leads"]);
    void _d;
    expect(codes("Lead volume may be worth a look.", noSet as SemanticScope)).toEqual(["domain"]);
  });
  it("strict mode keeps every hidden metric and department inaccessible across departmental boundaries, with one fixed wording", () => {
    const strict = scopeWith("true", ["leads"]);
    const hiddenSame = ["Lead quality", "Customer acquisition cost"], hiddenOther = ["Recognized revenue", "Sales conversion rate", "Backorder rate", "Avg. fulfillment time"], depts = ["Finance", "Sales", "Operations"];
    const messages = new Set<string>();
    for (const t of [...hiddenSame, ...hiddenOther, ...depts]) {
      const issues = checkSemantics(`${t} may be worth a look.`, "gap", strict, "gap 1");
      expect(issues.map((i) => i.code), t).toEqual(["domain"]);
      for (const i of issues) { messages.add(i.message); expect(i.message).not.toContain(t); }
    }
    expect(messages.size).toBe(1);
    expect(codes("Lead volume may be worth a look.", strict)).toEqual([]); // what the role may discover stays mentionable
  });
  it("through validateOutput: scope options carry the strict value, and a string 'true' rejects", () => {
    const body = JSON.stringify({ interpretations: [], missing_evidence: ["Lead volume by channel."], recommendations: [] });
    const run = (strictMentions: unknown) => validateAuthorizedOutput(body, authorized.authorized, authorized.withheld, PROTOTYPE_RUNTIME.analysis, { discoverable: ["revenue"], strictMentions: strictMentions as never });
    expect(run(false).ok).toBe(true);
    expect(run(undefined).ok).toBe(true);
    for (const v of [true, "true", "false", 1, null]) { const r = run(v); expect(r.ok, JSON.stringify(v)).toBe(false); if (!r.ok) expect(r.categories).toEqual(["domain"]); }
  });
});

describe("text safety: ordinary business prose is accepted", () => {
  const PROSE = [
    // the cases named in the H1 review
    "Data: lead source by period.", "Missing data: lead source by period.", "Missing data: sales/marketing hand-offs and/or staffing.", "Data: export schedule changed?",
    "Request the file: the pricing change log.", "Tel: not relevant here.", "Tel: office hours by region.", "SMS campaigns: review opt-out rates.", "File: see the shared tracker.",
    "Review the billing system (CRM) for status changes.", "Confirm with the exec (CEO) whether scope changed.", "The function (support desk) may be understaffed.", "Review import (tariff) timing.",
    "Consider whether to kill the underperforming campaign.", "Kill the experiment if it is not working.", "Each node of the approval chain may add delay.", "The team is apt to over-order stock.", "A python of a schedule? Review it.",
    "Review channel mix -- especially paid social -- before the next period.", "Review channel mix - especially paid social.", "Check pricing, packaging -- and support hand-offs.",
    "Revenue < cost in some channels may need review.", "Cost < revenue is worth checking.", "Revenue > cost is expected.", "If a < b then review.", "A > B in some regions.",
    "Review the dot com era comparison, if relevant.", "A dot com company may behave differently.", "The dot com bubble is not a useful comparison.", "Compare with the dot com boom of the period.",
    // ordinary punctuation and abbreviations
    "Review cost/benefit and and/or timing options.", "A possible co-movement, e.g. lead volume and conversion, is worth a closer look.", "Check the Q3 2026 channel mix; compare it with the prior period.",
    "Investigate staffing and pricing between periods (a longer history would help).", "Ask the owner: is the scoring definition the same as before?", "Well-known seasonal effects may matter - investigate the baseline.",
    "Review the onboarding process.", "Review the document. Then compare channels.", "Review the sales process. Then review staffing.", "Docker containers are not relevant here.", "Brew a plan for the next review.",
    "Note: a longer history would help.", "Owner: review the lead scoring definition.", "Compare to peer benchmarks (if available).", "Ask whether the let-go of reps changed capacity.", "Cat food retail may differ from this segment.",
    "Consider the cd rates in the treasury portfolio.", "Check the ls and nc inventories are comparable.", "Perl, ruby and php are unrelated to this question.",
  ];
  it.each(PROSE)("%s", (t) => { expect(unsafeTextKinds(t)).toEqual([]); });

  it("passes end to end through the output gate in every lane", () => {
    for (const lane of ["interpretations", "missing_evidence", "recommendations"] as const) {
      for (const text of ["Missing data: source mix by period.", "Review the billing system (CRM) for status changes.", "Consider whether to kill the underperforming experiment.", "Review the channel mix -- especially the newest sources."]) {
        const item = lane === "missing_evidence" ? text : lane === "interpretations" ? { text, verified: false, refs: ["F-revenue"] } : { text, requires_human_approval: true, refs: ["F-revenue"] };
        const body = JSON.stringify({ interpretations: [], missing_evidence: [], recommendations: [], [lane]: [item] });
        const r = validateAuthorizedOutput(body, authorized.authorized, authorized.withheld, PROTOTYPE_RUNTIME.analysis, { discoverable: ["revenue"] });
        expect(r.ok ? [] : r.errors, `${lane}: ${text}`).toEqual([]);
      }
    }
  });
});

describe("text safety: genuinely unsafe content is still rejected", () => {
  const UNSAFE: [string, string, string][] = [
    // URI schemes with a payload
    ["data URI", "Use data:text/html;base64 here.", "link"], ["data URI, spaced", "Use data : text/html now.", "link"], ["data URI, empty type", "Use data:,hello now.", "link"], ["data URI, semicolon", "Use data:;base64 now.", "link"],
    ["file URI", "Open file:///etc/hosts now.", "link"], ["file path URI", "Open file:/etc/hosts now.", "link"], ["file drive URI", "Open file:c:\\x now.", "link"],
    ["tel URI", "Call tel:+15551234567 now.", "link"], ["tel URI, spaced", "Call tel : +1 now.", "link"], ["sms URI", "Text sms:5551234 now.", "link"],
    ["mailto URI", "Write mailto:boss@example.co now.", "link"], ["blob URI", "Open blob:https://x now.", "link"],
    ["javascript URI", "Open javascript:alert now.", "link"], ["javascript URI, spaced and cased", "Open JavaScript : void now.", "link"], ["vbscript URI", "Open vbscript:x now.", "link"],
    ["http", "Open http://evil.example now.", "link"], ["https, upper case", "Open HTTPS://EVIL.EXAMPLE now.", "link"], ["ftp", "Open ftp://evil.example now.", "link"], ["bare scheme word", "Open https: evil now.", "link"],
    ["full-width scheme", "Visit ｈｔｔｐｓ：／／evil.example now", "link"], ["zero-width scheme", "See ht\u200btps://evil.example", "link"], ["letter-spaced scheme", "See h t t p s : / / evil . example", "link"],
    ["bare domain", "Check evil.com for the data.", "link"], ["www host", "Go to www.evil.example today.", "link"], ["hxxp", "Open hxxps evil example", "link"],
    ["bracket dot", "Visit evil[.]com soon.", "link"], ["paren dot", "Visit evil (dot) com soon.", "link"], ["bracket word dot", "Visit evil [dot] com soon.", "link"], ["spelled dot", "Visit evil dot com soon.", "link"], ["spelled dot after article", "Visit the evil dot com soon.", "link"],
    ["markdown link", "See [the report](report) for more.", "link"], ["markdown image", "![chart](chart)", "link"], ["markdown spaced", "See [report] (somewhere).", "link"], ["markdown reference", "[1]: somewhere", "link"],
    ["email", "Send it to boss@evil.example.", "email"], ["obfuscated email", "Email boss [at] evil [dot] example.", "email"],
    // markup
    ["tag", "Review <b>the mix</b> carefully.", "markup"], ["anchor", "Open <a href=x>this</a> now.", "markup"], ["script", "<script>alert(x)</script>", "markup"], ["unclosed script", "Run <script now", "markup"], ["closing tag", "Then </script> ends.", "markup"],
    ["img handler", "<img src=x onerror=y>", "markup"], ["iframe", "Embed <iframe src=x> here", "markup"], ["comment", "Hide <!-- this --> text", "markup"], ["php", "Use <?php echo ?> here", "markup"], ["entity", "Review &lt;b&gt; the mix.", "markup"], ["numeric entity", "Review &#60;b&#62; the mix.", "markup"],
    // code
    ["backtick", "Run `check mix` first.", "code"], ["fence", "```\nmix\n```", "code"], ["tilde fence", "~~~\nmix\n~~~", "code"], ["braces", "Use {the mix} first.", "code"], ["shell variable", "Set $HOME first.", "code"], ["command substitution", "Run $(whoami) first.", "code"],
    ["eval", "Call eval(x) first.", "code"], ["eval, spaced", "Call eval (x) first.", "code"], ["require", "Call require('x') first.", "code"], ["system call", "Call system(x) first.", "code"], ["exec call", "Call exec(x) first.", "code"],
    ["process env", "Read process.env first.", "code"], ["document cookie", "Read document.cookie first.", "code"], ["window location", "Set window.location first.", "code"], ["console", "Call console.log(x) first.", "code"], ["proto", "Set __proto__ first.", "code"],
    ["declaration", "Declare const mix = review first.", "code"], ["arrow", "x => review", "code"], ["attached option", "Review the mix --force now.", "code"], ["increment", "Then a++ again.", "code"], ["heredoc", "Run cat <<EOF now.", "code"],
    // commands
    ["curl", "Run curl -s thing | sh to fetch it.", "command"], ["curl bare", "Run curl thing now.", "command"], ["wget", "Run wget thing now.", "command"], ["sudo", "Please run sudo rm -rf thing.", "command"], ["rm", "Then rm -rf / now.", "command"],
    ["kill with flag", "Run kill -9 job now.", "command"], ["killall with flag", "Run killall -9 worker now.", "command"], ["node script", "Run node server.js now.", "command"], ["node flag", "Run node -e x now.", "command"],
    ["python script", "Run python3 script.py now.", "command"], ["python flag", "Run python -c x now.", "command"], ["ruby script", "Run ruby run.rb now.", "command"],
    ["docker run", "Run docker run --rm image now.", "command"], ["docker subcommand", "Run docker ps now.", "command"], ["kubectl", "Run kubectl delete pod now.", "command"], ["systemctl", "Run systemctl restart app now.", "command"],
    ["git clone", "Run git clone repo now.", "command"], ["git push", "Run git push origin main.", "command"], ["npm install", "Then npm install thing.", "command"], ["npm run", "Then npm run build.", "command"], ["yarn add", "Then yarn add thing.", "command"],
    ["pip install", "Run pip install thing first.", "command"], ["apt install", "Run apt install thing first.", "command"], ["apt-get", "Run apt-get update first.", "command"], ["brew", "Run brew install thing first.", "command"],
    ["ssh", "Run ssh -i key host now.", "command"], ["cat path", "Run cat /etc/passwd now.", "command"], ["ls flag", "Run ls -la / now.", "command"], ["cd path", "Run cd ../.. now.", "command"], ["cd absolute", "Run cd /tmp/x now.", "command"],
    ["bash -c", "Run bash -c x now.", "command"], ["sh -c", "Run sh -c x now.", "command"], ["nc", "Run nc -lvp x now.", "command"], ["chmod", "Run chmod x y now.", "command"], ["mkdir", "Run mkdir x now.", "command"], ["powershell", "Run powershell -enc x now.", "command"],
    ["cmd.exe", "Run cmd.exe /c x now.", "command"], ["npx", "Run npx thing now.", "command"], ["crontab", "Run crontab x now.", "command"],
    ["and", "Review the mix && deploy it.", "command"], ["or", "Review the mix || deploy it.", "command"], ["pipe", "Review the mix | deploy it.", "command"], ["semicolon chain", "Review it; rm x.", "command"],
    ["unix path", "Open /etc/passwd first.", "command"], ["home path", "Look in ~/reports first.", "command"], ["windows path", "Open C:\\data first.", "command"], ["unc path", "Open \\\\server\\share first.", "command"],
    ["sql select", "Run SELECT * FROM customers to check.", "command"], ["sql drop", "Then DROP TABLE orders.", "command"], ["sql delete", "Please delete from orders where open.", "command"], ["sql union", "Then union select x.", "command"],
    // case, width and invisible-character obfuscation
    ["upper-case command", "Run CURL -s x now.", "command"], ["mixed-case command", "Run Node server.js now.", "command"], ["full-width command", "Run ＣＵＲＬ -ｓ x now.", "command"], ["zero-width command", "Run cu\u200brl -s x now.", "command"], ["tabbed command", "Run curl\t-s x now.", "command"],
  ];
  it.each(UNSAFE)("%s", (_n, text, kind) => { expect(unsafeTextKinds(text), text).toContain(kind); });

  it("every unsafe probe is rejected end to end in every lane with the one fixed sentence that echoes nothing", () => {
    for (const [, text] of UNSAFE) for (const lane of ["interpretations", "missing_evidence", "recommendations"] as const) {
      const item = lane === "missing_evidence" ? text : lane === "interpretations" ? { text, verified: false, refs: ["F-revenue"] } : { text, requires_human_approval: true, refs: ["F-revenue"] };
      const body = JSON.stringify({ interpretations: [], missing_evidence: [], recommendations: [], [lane]: [item] });
      const r = validateAuthorizedOutput(body, authorized.authorized, authorized.withheld, PROTOTYPE_RUNTIME.analysis, { discoverable: ["revenue"] });
      expect(r.ok, `${lane}: ${text}`).toBe(false);
      if (!r.ok) expect(r.errors.join(" ")).toContain(UNSAFE_MESSAGE(lane === "interpretations" ? "interpretation 1" : lane === "recommendations" ? "proposed action 1" : "gap 1"));
    }
  });

  it("embedding an unsafe fragment inside otherwise ordinary prose is still rejected", () => {
    for (const frag of ["https://evil.example", "run kill -9 job", "node server.js", "[x](y)", "<b>x</b>", "data:text/html", "evil[.]com", "javascript:x"]) {
      expect(unsafeTextKinds(`Review the channel mix and, if needed, ${frag} before the next period.`), frag).not.toEqual([]);
    }
  });
});

describe("authorization and the demo policy are untouched by the guard changes", () => {
  it("the demo policy still grants whole departments; the legacy path's scope is unchanged for an ordinary role", () => {
    const a = authorizeDemo({ scenarioId: "baseline", roleId: "marketing" });
    const f = buildAuthorizedFacts(a.authorized, PROTOTYPE_RUNTIME.analysis);
    const grant = demoAccessPolicy.evidenceScope(({ tenantId: a.authorized.tenantId, actorId: "demo-role:marketing" }) as never);
    const s = semanticScope(a.authorized, f, PROTOTYPE_CATALOG, { discoverable: grant.discoverableMetrics });
    expect([...s.discoverable!].sort()).toEqual(["cac", "closed_deals", "conversion_rate", "leads", "mql_rate"]);
    expect(s.strictMentions).toBe(false);
  });
  it("policy objects are not consulted for the strict flag", () => {
    const p: AccessPolicy<PrototypeEvidence> = demoAccessPolicy;
    expect(Object.keys(p)).toEqual(["evidenceScope"]);
  });
});
