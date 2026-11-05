# dsh-workspace-purge

Really delete conversations and workspaces from the DeepSeek Harness sidebar.

Harness only archives conversations, and removing a workspace merely unregisters it:
its conversations stay on disk and show up under the virtual "Ungrouped" group.
This plugin deletes the whole thing instead — the session log, the projection cache and
the workspace registration go together, and workspace folders can go to the Recycle Bin.

## What gets removed

| Where | What |
| --- | --- |
| `~/.dsh/sessions/<cwd-slug>/<session>/` | the session log (`session.v4.jsonl.zstd`) |
| `~/.dsh/storages/session_projcache/sessions/<session>.json` | the title/row projection cache |
| `~/.dsh/storages/workspace.json` | the workspace registration, plus any archived/pinned marker for the session |
| the workspace folder (opt-in) | deleted only when you tick it and retype the folder name |

Everything is moved to the Windows Recycle Bin, so a mistake is recoverable. On other
platforms the files are removed directly.

## Usage

**Sidebar footer button** — the button at the bottom of the sidebar (labelled
"删除数据" / "Delete data") opens a panel with every workspace and its conversations,
the archived conversations, and any conversation that belongs to no workspace.
Tick what you want gone, or use the per-row delete button.

**Conversation menu** — each conversation's "…" menu gets an extra row that deletes
just that conversation, after a confirmation dialog.

**Agent tool** — the same code backs a `workspace_purge` tool, so the assistant can run
`list`, `delete-sessions` and `delete-workspaces` with the same guards.

The conversation you are currently talking in is never deleted: the panel marks it and
the Host half refuses it, because deleting its own log would pull the ground out from
under the running session.

## How it works

The Host half does not use `sessionPersistence` (which has no delete face) or
`workspaceRegistry.delete` alone. For every conversation it stops the agent, detaches
the live store entry, drops the archived/pinned markers, moves the log directory and the
projection record to the Recycle Bin and finally detaches it from its workspace. For a
workspace it deletes its conversations first, then the registration, then (if asked) the
folder. A folder is only accepted when it is not a drive root, not a parent of the
Harness home, and not a parent of another registered workspace.

When the Recycle Bin is unavailable (or PowerShell refuses), the item is renamed to
`<name>.purge-<timestamp>` instead of being silently kept, so nothing lingers as a
half-deleted record.

## Install

Once this plugin is listed in the [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
registry, install it from **Plugins → Discover** inside Harness.

Until then, build a tarball and add it to a profile:

```bash
npm pack
dsh plugin --profile desktop add ./dsh-workspace-purge-1.0.0.tgz
```

## Notes

- No network access, no telemetry, no credentials. The plugin only touches the four
  paths listed above, all under `DSH_HOME`.
- Windows is the supported platform for the Recycle Bin path. Elsewhere the plugin still
  deletes, but permanently.
- Removing the plugin leaves the sidebar back to its shipped behaviour; nothing is
  migrated or rewritten on uninstall.

## Development

```bash
node --check index.js
node --check client.js
node test/host-sim.mjs   # drives the Host half against an in-memory Harness
node tools/make-icon.mjs # regenerates assets/icon-180.png from icon.svg geometry
```

`tools/purge-orphans.mjs` is a one-off maintenance script for the conversations that sit
in no workspace at all; it is a dry run unless you pass `--apply`.

## License

MIT
