# Verification

Verified commit: a64367a9 on main 2dd5effe.

## Gates

Run on macOS 26.5.1 with Node 22.23.1 on that tree: `npm run typecheck`, `lint`
(oxlint plus `verify:module-boundaries`, 2172 files), `format:check`, `knip`,
`metadata:check`, `docs:check`, `jscpd` (3.43% duplicated lines), `scan:todos`
and `mcp-catalog:check` all exit 0. oxlint on the 12 changed TypeScript files
reports no finding that main does not already report for the same files.

`npm run test:prepare`, then `npm run test:changed` (the tests related to the
changed files): 84 files, 1531 passed, 3 skipped, 0 failed. They include:

- the service: an Evidence file projects exactly what the same Evidence projects
  inline; a capture whose response text exceeds the inline budget is refused
  inline with `resource_constraint` and projected from its file; a relative
  path, a missing file and JSON that is not Evidence are refused; the
  synchronous API refuses an unread file source;
- the compiled CLI: a request naming an Evidence file projects the same
  manifest as the same Evidence inline;
- MCP: inline, retained and file sources give identical manifests, outputs
  validate against the advertised schema, and a relative path is refused;
- the file source module: the size estimate, the authentication headroom
  refusal, a cancelled request refused before reading, and a read within the
  caller's resource scope; the service returns typed cancellation for a
  cancelled file request; a request aborted while it runs, even after its read, returns typed
  cancellation because the service yields before each check;
- the pair rule: three owner/repo pairs merge for collection and numeric detail
  routes, while two pairs, or three pairs sharing one namespace, stay literal;
  with `sibling-variance` also selected the pair still merges, because pairs
  are merged first. Each pair parameter keeps its role when
  `sibling-variance` later templates the segment before the pair.

## A rich capture

A Gitea 28.1.0 instance seeded through its API with an invented world (12
people, 4 organisations, 16 public repositories, 320 issues with about 600
comments, labels, milestones, commits, pull requests and releases) was read by
one `capture-browser-scenario` run of 1,217 API reads: 1,218 transactions in
24 s, 10.7 MB of Evidence, nothing dropped. Scenario parents are not on main,
so this run used this commit merged onto the scenario-capture change
(morluto/rea#5182) and packed for the host.

|                       | Inline source, previous rules         | Evidence-file source with `sibling-pair-variance` |
| --------------------- | ------------------------------------- | ------------------------------------------------- |
| Manifest              | `resource_constraint` (96 MiB budget) | built in 4.1 s, 459 MB maximum RSS                |
| Tools                 | 446 (with the budget raised by hand)  | 63                                                |
| Recorded exchanges    | 1,218                                 | 1,218                                             |
| Tools with one record | 77%                                   | 49%                                               |

The pair rule templated 25 route families as `{repo_namespace}/{repo_name}`.
A model provider that accepts at most 128 tools refused every request for the
446-tool manifest with HTTP 400.

The 63-tool environment was then exported, and in the AgentEnv runner its
smoke task passed and twelve generated retrieval tasks scored 12/12 with
`openai/gpt-oss-120b` and 12/12 with `zai-org/GLM-5.3-Flash`, with no provider
errors. The 446-tool manifest had scored 0/12 and 8/12 on its own generated
tasks, the 0 being the provider's tool limit rather than the model.
