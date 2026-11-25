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
      - uses: actions/checkout@v4
      - uses: danbuildss/breakra-action@v1
        with:
          spec: openapi.yaml
```

That's all. The action fetches the base commit itself, so the default shallow checkout is fine.

## What you get

| Verdict | Meaning | Check |
|---|---|---|
| **BLOCK** | At least one change will break existing callers (for example a removed operation or a new required parameter). | Fails |
| **REVIEW** | Changes that may break some callers, or that Breakra can't classify with certainty. | Fails only with `fail-on: review` |
| **SAFE** | No changes that break callers. | Passes |

If the contract can't be read or checked, the step **fails as "unchecked"**. It never passes silently. A contract that is new on the branch passes with verdict `new`.

The comment lists each change with the operation, where it is, why it matters and the recommended fix. A SAFE result never opens a new comment; it only updates an earlier one.

## Inputs

| Input | Default | Description |
|---|---|---|
| `spec` | (required) | Path to your OpenAPI 3.0/3.1 contract, JSON or YAML. |
| `fail-on` | `block` | `block`, or `review` to also fail on potentially breaking and unknown changes. |
| `use` | | Operations your code calls, one per line (`GET /orders/{id}`). Only changes that affect them count. |
| `comment` | `true` | Post or update the pull-request comment. |
| `base` | the PR's base commit | Git ref or SHA to compare against (for use outside `pull_request`). |
| `version` | `0.2.2` | The `breakra` npm version to run. Pinned, so your results change only when you choose. |
| `github-token` | `github.token` | Token used for the comment. |

## Outputs

`verdict` (`block`, `review`, `safe`, `new` or `error`), `breaking_count`, `analysis_id`, `result_file` (path to the full JSON result).

## Several contracts

Add one step per contract; each keeps its own comment.

```yaml
      - uses: danbuildss/breakra-action@v1
        with: { spec: services/orders/openapi.yaml }
      - uses: danbuildss/breakra-action@v1
        with: { spec: services/billing/openapi.json, fail-on: review }
```

## Security

- Use it with `pull_request`, not `pull_request_target`. It needs no secrets.
- It only uses the job's own token, to comment. Pull requests from forks get a read-only token, so there the result appears in the job summary instead.
- Text from the contract is escaped before it goes into the comment (no links, mentions or HTML from a hostile spec).
- Requires Node 20+ on the runner (GitHub-hosted runners have it).

## Run the same check locally

```sh
npx -y breakra check before.yaml after.yaml
```

Docs, the MCP server for coding agents and the hosted API: [breakra.dev](https://breakra.dev). Breakra checks API contract compatibility; it is not a security scanner.

## License

MIT
