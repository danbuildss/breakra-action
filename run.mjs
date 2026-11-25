// Breakra GitHub Action: compare a pull request's OpenAPI contract with its base and report what may break.
// Plain Node (20+), no dependencies. Runs the published `breakra` CLI with npx; nothing is sent to Breakra.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const RANK = { safe: 0, review: 1, block: 2 };
const MAX_ROWS = 50;
const MAX_COMMENT = 60_000; // GitHub's limit is 65,536 characters
const LABEL = {
  breaking: "Breaking",
  potentially_breaking: "Potentially breaking",
  unknown: "Unknown",
  compatible: "Compatible",
  non_contract: "Docs only",
};

/** Escape text from a contract so it renders as plain text in GitHub Markdown (no links, mentions or HTML). */
export function esc(value) {
  return String(value ?? "")
    .replace(/\r?\n|\r/g, " ")
    .replace(/[\\`*_{}[\]()#+\-.!|~>]/g, "\\$&")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/@/g, "&#64;")
    .replace(/:\/\//g, ":&#47;&#47;")
    .slice(0, 500);
}

/** Text for inside a Markdown code span (backslash escapes don't work there). */
export function code(value) {
  return `\`${String(value ?? "").replace(/[`\r\n]/g, "").slice(0, 300)}\``;
}

/** Escape a message for a GitHub workflow command (::error:: etc.). */
const cmd = (m) => String(m).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

export function marker(spec) {
  return `<!-- breakra-action:${Buffer.from(spec).toString("base64url")} -->`;
}

function where(c) {
  const op = c.operation ? `${c.operation.method} ${c.operation.path}` : "whole document";
  const l = c.location ?? {};
  const bits = [
    l.in && l.name ? `${l.in} ${l.name}` : null,
    l.status ? `response ${l.status}` : null,
    l.field ? `field ${l.field}` : null,
  ].filter(Boolean);
  return { op, at: bits.join(", ") };
}

/** Markdown report for one result. `result` is the CLI's JSON output (same shape as the hosted API). */
export function render(result, { spec, failOn, uses = [] }) {
  const impact = result.impact ?? null;
  const verdict = impact ? impact.verdict : result.verdict;
  const ids = impact ? new Set(impact.change_ids) : null;
  const shown = (result.changes ?? []).filter(
    (c) => c.compatibility !== "non_contract" && (!ids || ids.has(c.id)),
  );
  const s = result.summary ?? {};
  const counts = impact
    ? `${impact.affecting.breaking} breaking, ${impact.affecting.potentially_breaking} potentially breaking and ${impact.affecting.unknown} unknown change(s) affect the ${uses.length} operation(s) you use`
    : `${s.breaking ?? 0} breaking, ${s.potentially_breaking ?? 0} potentially breaking, ${s.unknown ?? 0} unknown and ${s.compatible ?? 0} compatible change(s)`;
  const head = {
    block: "🛑 **Breakra: BLOCK.** This change can break existing callers.",
    review: "⚠️ **Breakra: REVIEW.** Some changes may break callers; check them before merging.",
    safe: "✅ **Breakra: SAFE.** No changes that break callers were found.",
  }[verdict];
  const out = [
    marker(spec),
    head,
    "",
    `Contract ${code(spec)}: ${counts}. Suggested version bump: **${esc(result.suggested_version_bump)}**. The check fails at **${failOn}**.`,
  ];
  if (impact?.not_in_before?.length)
    out.push(
      "",
      `Not found in the base contract (check for typos): ${impact.not_in_before.map((u) => esc(`${u.method} ${u.path}`)).join(", ")}.`,
    );
  if (shown.length) {
    out.push("", "| | Operation | Where | Why | Fix |", "|---|---|---|---|---|");
    for (const c of shown.slice(0, MAX_ROWS)) {
      const w = where(c);
      out.push(
        `| ${LABEL[c.compatibility] ?? esc(c.compatibility)} | ${esc(w.op)} | ${esc(w.at)} | ${esc(c.reason)} | ${esc(c.recommended_action)} |`,
      );
    }
    if (shown.length > MAX_ROWS) out.push("", `…and ${shown.length - MAX_ROWS} more in the full result (\`result_file\` output).`);
  }
  if (result.limitations?.length) out.push("", `Limitations: ${result.limitations.map(esc).join("; ")}.`);
  out.push(
    "",
    `<sub>analysis_id ${code(result.analysis_id)} · engine ${esc(result.engine_version)} · rule set ${esc(result.rule_set_version)} · deterministic: rerun locally with ${code("npx breakra check")} · [Breakra](https://breakra.dev)</sub>`,
  );
  let md = out.join("\n");
  if (md.length > MAX_COMMENT) md = `${md.slice(0, MAX_COMMENT)}\n\n…truncated; see the full result in the job's \`result_file\` output.`;
  return { md, verdict, breaking: impact ? impact.affecting.breaking : (s.breaking ?? 0) };
}

/** Create or update this action's comment for `spec` on a pull request. Safe results never open a new comment. */
export async function upsertComment({ api, repo, number, token, spec, body, verdict, fetchImpl = fetch }) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "breakra-action",
  };
  const mark = marker(spec);
  let existing = null;
  for (let page = 1; page <= 10 && !existing; page++) {
    const r = await fetchImpl(`${api}/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`, { headers });
    if (!r.ok) throw new Error(`listing comments: HTTP ${r.status}`);
    const list = await r.json();
    existing = list.find((c) => c.user?.type === "Bot" && String(c.body ?? "").startsWith(mark)) ?? null;
    if (list.length < 100) break;
  }
  if (!existing && verdict === "safe") return "skipped";
  const r = await fetchImpl(
    existing ? `${api}/repos/${repo}/issues/comments/${existing.id}` : `${api}/repos/${repo}/issues/${number}/comments`,
    { method: existing ? "PATCH" : "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ body }) },
  );
  if (!r.ok) throw new Error(`${existing ? "updating" : "posting"} the comment: HTTP ${r.status}`);
  return existing ? "updated" : "created";
}

function git(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

export async function main(env = process.env) {
  const out = (k, v) => env.GITHUB_OUTPUT && appendFileSync(env.GITHUB_OUTPUT, `${k}=${v}\n`);
  const summary = (md) => env.GITHUB_STEP_SUMMARY && appendFileSync(env.GITHUB_STEP_SUMMARY, `${md}\n`);
  const fail = (msg) => {
    console.log(`::error title=Breakra::${cmd(msg)}`);
    summary(`❌ **Breakra: unchecked.** ${msg}`);
    out("verdict", "error");
    return 2;
  };

  const spec = (env.INPUT_SPEC ?? "").trim();
  const failOn = (env.INPUT_FAIL_ON || "block").trim();
  const version = (env.INPUT_VERSION || "0.2.2").trim();
  const uses = (env.INPUT_USE ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  if (!spec) return fail("Set the `spec` input to your OpenAPI file.");
  if (!(failOn in RANK) || failOn === "safe") return fail("`fail-on` must be block or review.");
  if (!/^\d+\.\d+\.\d+$/.test(version)) return fail("`version` must be an exact version such as 0.2.2.");

  const event = env.GITHUB_EVENT_PATH && existsSync(env.GITHUB_EVENT_PATH) ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) : {};
  const pr = event.pull_request ?? null;
  const base = (env.INPUT_BASE ?? "").trim() || pr?.base?.sha || "";
  if (!base) return fail("No base to compare with: run on pull_request, or set the `base` input.");
  if (base.startsWith("-")) return fail("`base` must be a git ref or SHA.");

  const headPath = resolve(workspace, spec);
  if (!headPath.startsWith(resolve(workspace))) return fail("`spec` must be inside the repository.");
  if (!existsSync(headPath)) return fail(`${spec} was not found in this branch.`);

  // Fetch just the base commit (works with the default shallow checkout).
  if (git(["cat-file", "-e", `${base}^{commit}`], workspace).status !== 0)
    git(["fetch", "--no-tags", "--depth=1", "origin", base], workspace);
  const relSpec = spec.replace(/^\.\//, "");
  const shown = git(["show", `${base}:${relSpec}`], workspace);
  if (shown.status !== 0) {
    if (git(["cat-file", "-e", `${base}^{commit}`], workspace).status !== 0)
      return fail(`Couldn't fetch the base commit ${base.slice(0, 40)}.`);
    console.log(`${spec} is new on this branch: nothing to compare.`);
    summary(`ℹ️ **Breakra:** ${code(spec)} is new on this branch; nothing to compare.`);
    out("verdict", "new");
    return 0;
  }

  // Run outside the checkout so npx never resolves a local package named "breakra".
  const dir = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), "breakra-"));
  const ext = /\.ya?ml$/i.test(spec) ? ".yaml" : ".json";
  writeFileSync(join(dir, `base${ext}`), shown.stdout);
  writeFileSync(join(dir, `head${ext}`), readFileSync(headPath));
  const args = ["-y", `breakra@${version}`, "check", `base${ext}`, `head${ext}`, "--json", "--fail-on", failOn];
  for (const u of uses) args.push("--use", u);
  const run = spawnSync(env.BREAKRA_NPX || "npx", args, { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0 && run.status !== 1)
    return fail(`The check could not run: ${(run.stderr || run.error?.message || "unknown error").trim().slice(0, 300)}`);
  let result;
  try {
    result = JSON.parse(run.stdout);
  } catch {
    return fail("The check returned no result.");
  }
  const resultFile = join(dir, "result.json");
  writeFileSync(resultFile, JSON.stringify(result, null, 2));

  const { md, verdict, breaking } = render(result, { spec, failOn, uses });
  summary(md);
  out("verdict", verdict);
  out("breaking_count", breaking);
  out("analysis_id", result.analysis_id);
  out("result_file", resultFile);
  console.log(`Breakra verdict for ${spec}: ${verdict.toUpperCase()} (${result.analysis_id})`);

  if (pr && (env.INPUT_COMMENT ?? "true").trim() !== "false") {
    try {
      const how = await upsertComment({
        api: env.GITHUB_API_URL || "https://api.github.com",
        repo: env.GITHUB_REPOSITORY,
        number: pr.number,
        token: env.INPUT_TOKEN,
        spec,
        body: md,
        verdict,
      });
      console.log(`Pull-request comment: ${how}.`);
    } catch (e) {
      console.log(
        `::warning title=Breakra::Couldn't comment on the pull request (${cmd(e.message)}). Give the job "pull-requests: write"; pull requests from forks can't be commented on, so the result is in the job summary.`,
      );
    }
  }
  const failed = RANK[verdict] >= RANK[failOn];
  if (failed) console.log(`::error title=Breakra::${verdict.toUpperCase()}: see the job summary for each change and how to fix it.`);
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main();
