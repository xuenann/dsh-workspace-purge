#!/usr/bin/env node
/**
 * Remove every "stray" conversation: a session log directory (or a leftover projection
 * record) that no Workspace registration claims.
 *
 * Dry run by default; pass --apply to actually move the items to the Recycle Bin.
 * Nothing is ever hard-deleted, and anything touched is reported per item.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const DSH = join(homedir(), '.dsh')
const SESSIONS = join(DSH, 'sessions')
const CACHE = join(DSH, 'storages', 'session_projcache', 'sessions')
const REGISTRY = join(DSH, 'storages', 'workspace.json')
const APPLY = process.argv.includes('--apply')
/** A session directory touched within this window is considered in use and is kept. */
const RECENT_MS = 30 * 60 * 1000

const bare = (id) => (id.startsWith('session-') ? id.slice('session-'.length) : id)
const kinds = (id) => [...new Set([id, bare(id), `session-${bare(id)}`])]

const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'))
const workspaces = registry.tables?.workspaces ?? {}
const claimed = new Set()
for (const workspace of Object.values(workspaces)) {
  for (const sessionId of workspace.sessionIds ?? []) claimed.add(bare(sessionId))
}
const archived = new Set((registry.global?.archivedSessionIds ?? []).map(bare))
const pinned = new Set((registry.global?.pinnedSessionIds ?? []).map(bare))

const disk = []
for (const slug of readdirSync(SESSIONS)) {
  const slugDir = join(SESSIONS, slug)
  let entries
  try {
    entries = readdirSync(slugDir, { withFileTypes: true })
  } catch {
    continue
  }
  for (const entry of entries) {
    if (entry.isDirectory() !== true) continue
    const dir = join(slugDir, entry.name)
    let stat
    try {
      stat = statSync(dir)
    } catch {
      continue
    }
    disk.push({
      name: entry.name,
      id: bare(entry.name),
      dir,
      slug,
      mtime: stat.mtimeMs,
      cache: kinds(entry.name)
        .map((kind) => join(CACHE, `${kind}.json`))
        .filter((path) => existsSync(path)),
    })
  }
}

const now = Date.now()
const keep = { claimed: [], archived: [], recent: [] }
const strays = []
for (const item of disk) {
  if (claimed.has(item.id)) keep.claimed.push(item)
  else if (archived.has(item.id)) keep.archived.push(item)
  else if (now - item.mtime < RECENT_MS) keep.recent.push(item)
  else strays.push(item)
}

const diskNames = new Set(disk.map((item) => item.name))
const cacheFiles = readdirSync(CACHE).filter((name) => name.endsWith('.json'))
const cacheStrays = []
const cacheKept = []
for (const name of cacheFiles) {
  const id = bare(name.slice(0, -'.json'.length))
  const owned = disk.some((item) => item.id === id)
  if (owned === false) cacheStrays.push(join(CACHE, name))
  else cacheKept.push(name)
}

const listing = strays
  .sort((left, right) => right.mtime - left.mtime)
  .map((item) => ({
    id: item.id,
    slug: item.slug,
    mtime: new Date(item.mtime).toISOString(),
    cache: item.cache.length,
  }))

console.log(
  JSON.stringify(
    {
      apply: APPLY,
      workspaces: Object.keys(workspaces).length,
      claimedIds: claimed.size,
      archivedIds: archived.size,
      pinnedIds: pinned.size,
      diskDirs: disk.length,
      cacheFiles: cacheFiles.length,
      keep: {
        claimed: keep.claimed.length,
        archived: keep.archived.map((item) => item.name),
        recent: keep.recent.map((item) => ({ id: item.id, mtime: new Date(item.mtime).toISOString() })),
      },
      strays: listing.length,
      straySessions: listing,
      cacheStrays: cacheStrays.length,
      cacheStraysSample: cacheStrays.slice(0, 5),
      cacheKeptUnused: cacheKept.length,
      diskNamesSample: [...diskNames].slice(0, 3),
    },
    null,
    2,
  ),
)

if (APPLY !== true) {
  console.log('\ndry run — re-run with --apply to move these to the Recycle Bin')
  process.exit(0)
}

const targets = [...strays.map((item) => item.dir), ...strays.flatMap((item) => item.cache), ...cacheStrays]
const unique = [...new Set(targets)]
if (unique.length === 0) {
  console.log('nothing to remove')
  process.exit(0)
}

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`
const script = join(tmpdir(), `orphan-purge-${Date.now()}-${process.pid}.ps1`)
const lines = ['$ErrorActionPreference = "Continue"', 'Add-Type -AssemblyName Microsoft.VisualBasic']
for (const path of unique) {
  const q = quote(path)
  lines.push(
    `if (Test-Path -LiteralPath ${q} -PathType Container) { try { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(${q},'OnlyErrorDialogs','SendToRecycleBin'); Write-Output ("OK " + ${q}) } catch { Write-Output ("FAIL " + ${q} + "::" + $_.Exception.Message) } } elseif (Test-Path -LiteralPath ${q} -PathType Leaf) { try { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(${q},'OnlyErrorDialogs','SendToRecycleBin'); Write-Output ("OK " + ${q}) } catch { Write-Output ("FAIL " + ${q} + "::" + $_.Exception.Message) } } else { Write-Output ("MISSING " + ${q}) }`,
  )
}
writeFileSync(script, `\ufeff${lines.join('\r\n')}`, 'utf8')

const run = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
  { encoding: 'utf8', windowsHide: true, timeout: 600_000 },
)
const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
const ok = output.split(/\r?\n/).filter((line) => line.startsWith('OK ')).length
const failed = output.split(/\r?\n/).filter((line) => line.startsWith('FAIL ')).length
const missing = output.split(/\r?\n/).filter((line) => line.startsWith('MISSING ')).length
console.log(JSON.stringify({ requested: unique.length, ok, failed, missing, exit: run.status }, null, 2))
if (failed > 0 || run.status !== 0) {
  console.log(output.split(/\r?\n/).filter((line) => line.startsWith('FAIL ')).slice(0, 20).join('\n'))
}
