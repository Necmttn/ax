# Releasing agentctl

Releases are managed by Release Please and GitHub Release artifacts.

## Normal release

1. Merge feature commits to `main` using Conventional Commits.
2. Wait for the Release Please PR to update `package.json`, `CHANGELOG.md`, and the release tag.
3. Confirm CI passes on the release PR:
   - `bun test`
   - `bun run typecheck`
   - `bun run check:cli-reference`
   - `bun run build`
   - compiled CLI smoke checks
4. Merge the Release Please PR.
5. Confirm the release workflow uploads:
   - `agentctl-darwin-arm64.tar.gz`
   - `agentctl-linux-x64.tar.gz`
   - `checksums.txt`
6. Verify install/update from the published release:

```bash
agentctl update --check
agentctl update
agentctl --version
agentctl doctor
```

## Manual artifact rebuild

Use the `Release Please` workflow dispatch with `tag_name` set to an existing tag.
This rebuilds and re-uploads release artifacts without creating a new release PR.

## Release notes

Call out user-visible CLI changes, installer flags, daemon behavior, schema changes,
and migration or reinstall steps. Keep implementation details in the changelog unless
they affect how people operate the tool.
