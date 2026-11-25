# Session title from the latest messages

Registers the session-title provider `session-title-latest-llm`. On every human
message the host asks it for a title; it sends only the newest two human
messages (configurable via `count`) plus the current provider title, and asks
the model to title what the recent exchange is about.

## Why

The shipped experimental provider sends *all* human messages and instructs the
model to keep an existing title unless the main topic changed materially. In
long sessions that biases titles to the opening topic. It also fails hard when
the all-messages payload passes its byte budget, which leaves the
first-message fallback in place.

## Behavior

- Input: the newest `count` human messages (default 2).
- Anchor: the existing title is passed as `currentTitle` only when it was
  produced by a provider; a truncated first-message fallback is replaced.
- Payload trimming: oldest messages are dropped, then the newest text keeps its
  tail, so the request never exceeds `maxInputBytes` and never fails on size.
- Output: first non-empty line, normalized to one line.
- Forked Sessions: the fork flow names a branch `"<parent> (1)"` through the
  rename API, which stores a `user`-sourced title. The title service treats a
  user title as pinned and skips automatic refreshes, so a fresh fork used to
  keep that name forever. With `unpinForkedTitles: true` this provider watches
  the first new human message of a seeded Session whose title still ends in
  ` (n)` and runs one explicit refresh, replacing the pin with a provider title;
  later updates then follow the normal per-message path. A title the user typed
  without the ` (n)` shape is left alone.
- Titles the user renames by hand stay pinned by design (an explicit refresh is
  the only unpin), so they are not overwritten.

## Install state

- Bundle row added by `cordis.patch.yml` as `session-title-latest`; the patch
  also disables the base `session-title-llm` first-prompt provider, because the
  `session-title` service accepts exactly one provider.
- `@deepseek-ai/dsh-experimental-session-titles-bundle` is disabled, so its
  Settings toggle ("随对话更新的标题", experimental) no longer appears.
- Shipped `@deepseek-ai/*` packages are loaded from the running installation
  with `createRequire`, not from a profile dependency.

## Verification

- `node --check` on both modules.
- `input.js` unit tests: window selection, framing, byte-budget trimming, UTF-8
  safe tail truncation.
- `generate()` integration test with a fake `ctx.llm`: newest-two seqs only,
  emphasis unwrapping, anchored request.
- `install_bundle` reported `application: applied` with no activation
  diagnostic; the failed first attempt reported the exact import error, so the
  absence here is meaningful.

## Rollback

1. `plugin_manager` → `remove_bundle` → `@todrink/dsh-better-titles`.
2. Re-enable `@deepseek-ai/dsh-experimental-session-titles-bundle`.
3. Or restore the profile backups
   `package.json.bak-session-title-latest-*` / `cordis.patch.yml.bak-session-title-latest-*`.

## Not observed live

No human message arrived after the profile reload, so no live title refresh was
watched end to end. The next human message in any session should append a
`session/title` event whose `source.provider` is `session-title-latest-llm`.
