# Breakra GitHub Action

**Catch breaking API changes before they ship.** On every pull request, Breakra compares your OpenAPI contract with the base branch and tells you what may break existing callers, why, and how to fix it.

- **Deterministic:** the same two contracts always give the same verdict and `analysis_id`. No AI in the verdict.
- **Free and private:** runs the open-source [`breakra`](https://www.npmjs.com/package/breakra) CLI on the runner. Nothing is sent to Breakra; no account, no API key.
- **One comment per pull request**, updated on each push, plus the same report in the job summary.

## Usage

```yaml
# .github/workflows/api-contract.yml
name: API contract
on:
  pull_request:
    paths: [openapi.yaml]

permissions:
  contents: read
  pull-requests: write # for the comment; remove it and set comment: false to use the job summary only

jobs:
  breakra:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: danbuildss/breakra-action@v1
        with:
          spec: openapi.yaml
```

That's all. The action fetches the base commit itself, so the default shallow checkout is fine.

## What you get

| Verdict | Meaning | Check |
|---|---|---|
| **BLOCK** | A change that breaks every caller of it: an operation was removed. | Fails |
| **REVIEW** | Changes that can break callers depending on how they use the API: a new required parameter or request field, a removed or no-longer-guaranteed response field, a narrowed enum, and changes Breakra can't classify with certainty. | Fails (default); passes with `fail-on: block` |
| **SAFE** | No changes that break callers. | Passes |

Most real-world breakages are REVIEW-level, so the check fails on them by default. Set `fail-on: block` to fail only when an operation is removed; the comment still lists every change.

If the contract can't be read or checked, the step **fails as "unchecked"**. It never passes silently. A contract that is new on the branch passes with verdict `new`.

The comment lists each change with the operation, where it is, why it matters and the recommended fix. A SAFE result never opens a new comment; it only updates an earlier one.

## Inputs

| Input | Default | Description |
|---|---|---|
| `spec` | (required) | Path to your OpenAPI 3.0/3.1 contract, JSON or YAML. |
| `fail-on` | `review` | `review` fails on breaking, potentially breaking and unknown changes; `block` fails only on breaking ones (a removed operation). |
| `use` | | Operations your code calls, one per line (`GET /orders/{id}`). Only changes that affect them count. |
| `comment` | `true` | Post or update the pull-request comment. |
| `base` | the PR's base commit | Git ref or SHA to compare against (for use outside `pull_request`). |
| `version` | `0.3.0` | The `breakra` npm version to run. Pinned, so your results change only when you choose. 0.3.0 accepts contracts up to 25 MB per file (whole GitHub-scale APIs). |
| `github-token` | `github.token` | Token used for the comment. |

## Outputs

`verdict` (`block`, `review`, `safe`, `new` or `error`), `breaking_count`, `analysis_id`, `result_file` (path to the full JSON result).

## Several contracts

Add one step per contract; each keeps its own comment.

```yaml
      - uses: danbuildss/breakra-action@v1
        with: { spec: services/orders/openapi.yaml }
      - uses: danbuildss/breakra-action@v1
        with: { spec: services/billing/openapi.json, fail-on: block }
```

## Security

- Use it with `pull_request`, not `pull_request_target`. It needs no secrets.
- It only uses the job's own token, to comment. Pull requests from forks get a read-only token, so there the result appears in the job summary instead.
- Text from the contract is escaped before it goes into the comment (no links, mentions or HTML from a hostile spec).
- Requires Node 20+ on the runner (GitHub-hosted runners have it).
- Large contracts: the default `breakra` 0.3.0 accepts up to 25 MB per file, 20,000 operations and 5,000,000 nodes once `$ref`s are expanded (GitHub's full REST description checks in about 8 s).

## Run the same check locally

```sh
npx -y breakra check before.yaml after.yaml
```

Docs, the MCP server for coding agents and the hosted API: [breakra.dev](https://breakra.dev). Breakra checks API contract compatibility; it is not a security scanner.

## License

MIT
