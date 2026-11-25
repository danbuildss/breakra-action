// node --test test/  (no dependencies). The end-to-end test runs the published CLI with npx (needs the npm registry).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { esc, main, marker, render, upsertComment } from "../run.mjs";

const fx = (p) => join(import.meta.dirname, "fixtures", p);
const json = (p) => JSON.parse(readFileSync(fx(p), "utf8"));

test("esc neutralises links, mentions, HTML, tables and line breaks from a hostile contract", () => {
  const out = esc("[x](https://evil.example) @team <img src=x> a|b\n## heading ![i](j)");
  assert.doesNotMatch(out, /\]\(|https:\/\/|@team|<img|\n/);
  assert.match(out, /\\\|/);
  assert.equal(esc("a".repeat(900)).length, 500);
});

test("BLOCK result lists the breaking change with its reason and fix, and hides docs-only changes", () => {
  const r = json("breaking/expected.json");
  const { md, verdict, breaking } = render(r, { spec: "openapi.yaml", failOn: "block" });
  assert.equal(verdict, "block");
  assert.equal(breaking, 1);
  assert.ok(md.startsWith(marker("openapi.yaml")));
  assert.match(md, /Breakra: BLOCK/);
  assert.match(md, /\| Breaking \| POST \/orders \|/);
  assert.match(md, /Callers of it will receive errors\\\./);
  assert.doesNotMatch(md, /Docs only/);
  assert.ok(md.includes(r.analysis_id));
});

test("SAFE result says so with no change table", () => {
  const { md, verdict } = render(json("safe/expected.json"), { spec: "api/openapi.json", failOn: "review" });
  assert.equal(verdict, "safe");
  assert.match(md, /Breakra: SAFE/);
  assert.match(md, /fails at \*\*review\*\*/);
});

test("with `use`, only changes affecting those operations count", () => {
  const { md, verdict, breaking } = render(json("breaking/result-use.json"), {
    spec: "openapi.yaml",
    failOn: "block",
    uses: ["GET /orders"],
  });
  assert.equal(verdict, "safe");
  assert.equal(breaking, 0);
  assert.match(md, /affect the 1 operation\(s\) you use/);
  assert.doesNotMatch(md, /POST \/orders/);
});

function fakeGitHub(comments) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body && JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => (init.method ? {} : comments) };
  };
  return { calls, fetchImpl };
}
const base = { api: "https://api.github.com", repo: "o/r", number: 7, token: "t", spec: "openapi.yaml" };

test("comment: created when none exists, updated when ours exists, other comments untouched", async () => {
  let gh = fakeGitHub([]);
  assert.equal(await upsertComment({ ...base, body: "x", verdict: "block", fetchImpl: gh.fetchImpl }), "created");
  assert.equal(gh.calls[1].method, "POST");
  assert.match(gh.calls[1].url, /issues\/7\/comments$/);

  gh = fakeGitHub([
    { id: 1, user: { type: "User" }, body: `${marker("openapi.yaml")} pasted by a person` },
    { id: 2, user: { type: "Bot" }, body: `${marker("other.yaml")}` },
    { id: 3, user: { type: "Bot" }, body: `${marker("openapi.yaml")}\nold` },
  ]);
  assert.equal(await upsertComment({ ...base, body: "new", verdict: "safe", fetchImpl: gh.fetchImpl }), "updated");
  assert.equal(gh.calls[1].method, "PATCH");
  assert.match(gh.calls[1].url, /issues\/comments\/3$/);
  assert.equal(gh.calls[1].body.body, "new");
});

test("comment: a SAFE result never opens a new comment", async () => {
  const gh = fakeGitHub([]);
  assert.equal(await upsertComment({ ...base, body: "x", verdict: "safe", fetchImpl: gh.fetchImpl }), "skipped");
  assert.equal(gh.calls.length, 1);
});

// --- end to end, in a temporary git repository, with the published CLI ---
function repo(beforeFile, afterFile) {
  const dir = mkdtempSync(join(tmpdir(), "breakra-action-"));
  const sh = (...a) => {
    const r = spawnSync("git", a, { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  sh("init", "-q", "-b", "main");
  sh("config", "user.email", "t@example.com");
  sh("config", "user.name", "t");
  if (beforeFile) {
    copyFileSync(fx(beforeFile), join(dir, "openapi.yaml"));
    sh("add", ".");
    sh("commit", "-qm", "base");
  } else {
    writeFileSync(join(dir, "README"), "x");
    sh("add", ".");
    sh("commit", "-qm", "base");
  }
  const baseSha = sh("rev-parse", "HEAD");
  copyFileSync(fx(afterFile), join(dir, "openapi.yaml"));
  sh("add", ".");
  sh("commit", "-qm", "change");
  const event = join(dir, "..", `${dir.split("/").pop()}-event.json`);
  writeFileSync(event, JSON.stringify({ pull_request: { number: 1, base: { sha: baseSha } } }));
  const output = join(dir, "..", `${dir.split("/").pop()}-out`);
  const stepSummary = join(dir, "..", `${dir.split("/").pop()}-summary`);
  writeFileSync(output, "");
  writeFileSync(stepSummary, "");
  return { dir, event, output, stepSummary };
}
const env = (r, extra = {}) => ({
  ...process.env,
  GITHUB_WORKSPACE: r.dir,
  GITHUB_EVENT_PATH: r.event,
  GITHUB_OUTPUT: r.output,
  GITHUB_STEP_SUMMARY: r.stepSummary,
  INPUT_SPEC: "openapi.yaml",
  INPUT_COMMENT: "false",
  ...extra,
});

test("end to end: a breaking pull request fails with the engine's analysis_id", { timeout: 120_000 }, async () => {
  const r = repo("breaking/before.yaml", "breaking/after.yaml");
  assert.equal(await main(env(r)), 1);
  const out = readFileSync(r.output, "utf8");
  assert.match(out, /verdict=block/);
  assert.match(out, /breaking_count=1/);
  assert.ok(out.includes(`analysis_id=${json("breaking/expected.json").analysis_id}`));
  assert.match(readFileSync(r.stepSummary, "utf8"), /Breakra: BLOCK/);
});

test("end to end: a safe pull request passes, even at fail-on review", { timeout: 120_000 }, async () => {
  const r = repo("safe/before.yaml", "safe/after.yaml");
  assert.equal(await main(env(r, { INPUT_FAIL_ON: "review" })), 0);
  assert.match(readFileSync(r.output, "utf8"), /verdict=safe/);
});

test("end to end: a contract added on this branch passes with verdict new", { timeout: 120_000 }, async () => {
  const r = repo(null, "safe/after.yaml");
  assert.equal(await main(env(r)), 0);
  assert.match(readFileSync(r.output, "utf8"), /verdict=new/);
});

test("end to end: an unreadable contract is unchecked (exit 2), never a pass", { timeout: 120_000 }, async () => {
  const r = repo("safe/before.yaml", "safe/after.yaml");
  writeFileSync(join(r.dir, "openapi.yaml"), "openapi: [not valid");
  assert.equal(await main(env(r)), 2);
  assert.match(readFileSync(r.output, "utf8"), /verdict=error/);
  assert.match(readFileSync(r.stepSummary, "utf8"), /unchecked/);
});

test("bad inputs are refused before anything runs", async () => {
  const r = repo("safe/before.yaml", "safe/after.yaml");
  assert.equal(await main(env(r, { INPUT_FAIL_ON: "safe" })), 2);
  assert.equal(await main(env(r, { INPUT_VERSION: "latest" })), 2);
  assert.equal(await main(env(r, { INPUT_SPEC: "../outside.yaml" })), 2);
  assert.equal(await main(env(r, { INPUT_BASE: "--upload-pack=x" })), 2);
});

test("default fail-on is review: a new required parameter fails the check", { timeout: 120_000 }, async () => {
  const r = repo("review/before.yaml", "review/after.yaml");
  assert.equal(await main(env(r)), 1);
  assert.match(readFileSync(r.output, "utf8"), /verdict=review/);
});

test("fail-on: block lets a REVIEW change pass (the comment still lists it)", { timeout: 120_000 }, async () => {
  const r = repo("review/before.yaml", "review/after.yaml");
  assert.equal(await main(env(r, { INPUT_FAIL_ON: "block" })), 0);
  assert.match(readFileSync(r.stepSummary, "utf8"), /new required query parameter/);
});
