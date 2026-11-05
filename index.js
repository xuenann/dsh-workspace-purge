/**
 * Host half of dsh-workspace-purge.
 *
 * The platform has no delete face for conversations: `workspaceController.delete`
 * only unregisters a Workspace (its sessions then fall into the "ungrouped" bucket)
 * and `sessionPersistence` exposes no delete at all. This plugin therefore does the
 * removal out of band, in one place, so the sidebar panel and the agent tool share
 * exactly one implementation:
 *
 *   1. stop a session's running work (`workspaceRegistry.stopSessionActivity`);
 *   2. detach the live Session from the in-memory store (`ctx.sessions.detachEntered`);
 *   3. un-hang the session from every Workspace and drop archived/pinned markers;
 *   4. move its project directory (`<DSH_HOME>/sessions/<project>/<id>`) and its
 *      projection-cache record to the Windows Recycle Bin;
 *   5. for a Workspace: its sessions first, then `workspaceRegistry.delete(id)`,
 *      and only when the user ticks the folder box, the folder itself.
 *
 * Everything that leaves the disk goes through the Recycle Bin, so a mistake is
 * recoverable from Explorer. When the Recycle Bin cannot be used the plugin refuses
 * to hard-delete; it stages the item aside instead.
 *
 * The body runs inside a self-scheduled cordis `inject` gate: a plugin mounted by the
 * Loader receives its own `apply` directly, and cordis only follows an `inject`
 * declaration of a derived context on a reload path. `ctx.inject(names, cb)` binds the
 * services in the CALLBACK's fiber, which is the documented way to reach them.
 */
import { spawn } from 'node:child_process'
import { stat, rename, writeFile, rm, readFile, readdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, parse as parsePath } from 'node:path'

export const name = 'workspace-purge'
export const inject = ['webServer', 'connection', 'workspaceRegistry', 'sessionPersistence', 'sessions', 'subagents']

/** RPC channel used by the Client half. */
const CHANNEL = '/dsh-workspace-purge'

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** Services every endpoint needs; absent ones degrade the feature instead of breaking apply(). */
const REQUIRED_SERVICES = ['workspaceRegistry', 'sessionPersistence']

/** Services the handlers reach; read through the gate so a missing one degrades instead of throwing. */
const NEEDED_SERVICES = ['connection', 'webServer', 'workspaceRegistry', 'sessionPersistence', 'sessions', 'subagents', 'storageDomain', 'tools']

/** How long to wait for the inject gate before saying so loudly. */
const GATE_TIMEOUT_MS = 15_000

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

function errText(error) {
  if (error === undefined || error === null) return String(error)
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return text.length > 800 ? `${text.slice(0, 800)}…` : text
}

async function pathInfo(path) {
  try {
    const info = await stat(path)
    return { exists: true, isDirectory: info.isDirectory() }
  } catch {
    return { exists: false, isDirectory: false }
  }
}

function isSamePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = resolve(a).replace(/[\\/]+$/, '').toLowerCase()
  const right = resolve(b).replace(/[\\/]+$/, '').toLowerCase()
  return left === right
}

/** True when `child` equals or sits below `parent`. */
function isInsideOrEqual(parent, child) {
  if (typeof child !== 'string' || typeof parent !== 'string') return false
  const inner = resolve(child).replace(/[\\/]+$/, '').toLowerCase()
  const outer = resolve(parent).replace(/[\\/]+$/, '').toLowerCase()
  if (inner === outer) return true
  return inner.startsWith(outer.endsWith(':\\') ? outer : `${outer}\\`)
}

/** Quote one path as a PowerShell single-quoted literal. */
function quotePs(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function runPowerShell(args, timeoutMs = 30_000) {
  return new Promise((settle) => {
    let child
    try {
      child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      settle({ code: -1, stdout: '', stderr: errText(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      settle({ code: -1, stdout, stderr: `${stderr}${errText(error)}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      settle({ code: code ?? -1, stdout, stderr })
    })
  })
}

/**
 * Move every path to the Windows Recycle Bin with the .NET file-system helper: one
 * PowerShell run for the whole batch, then a `stat` re-check so the caller learns the
 * truth instead of an exit code.
 */
async function sendToRecycleBin(paths) {
  const unique = [...new Set(paths.filter((path) => typeof path === 'string' && path.length > 0))]
  const result = { recycled: [], failed: [] }
  if (unique.length === 0) return result
  if (process.platform !== 'win32') {
    for (const path of unique) result.failed.push({ path, error: 'the Recycle Bin is Windows-only' })
    return result
  }

  // Statements are newline-joined: `;` followed by `elseif` is a PowerShell syntax error.
  const perPath = unique.map(
    (path) => `if (Test-Path -LiteralPath ${quotePs(path)} -PathType Container) {
  try {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(${quotePs(path)}, 'OnlyErrorDialogs', 'SendToRecycleBin')
    Write-Output ${quotePs(`OK ${path}`)}
  } catch {
    Write-Output (${quotePs(`FAIL ${path}::`)} + $_.Exception.Message)
  }
} elseif (Test-Path -LiteralPath ${quotePs(path)} -PathType Leaf) {
  try {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(${quotePs(path)}, 'OnlyErrorDialogs', 'SendToRecycleBin')
    Write-Output ${quotePs(`OK ${path}`)}
  } catch {
    Write-Output (${quotePs(`FAIL ${path}::`)} + $_.Exception.Message)
  }
} else {
  Write-Output ${quotePs(`MISSING ${path}`)}
}`,
  )

  const script = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Microsoft.VisualBasic
${perPath.join('\n')}
`
  const scriptPath = join(tmpdir(), `wspurge-${Date.now()}-${process.pid}.ps1`)
  try {
    await writeFile(scriptPath, '\uFEFF' + script, 'utf8')
  } catch (error) {
    for (const path of unique) result.failed.push({ path, error: `cannot write the helper script: ${errText(error)}` })
    return result
  }
  try {
    const run = await runPowerShell(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath])
    const reported = new Map()
    for (const line of `${run.stdout}\n${run.stderr}`.split(/\r?\n/)) {
      const ok = line.match(/^OK (.+)$/)
      if (ok !== null) reported.set(ok[1], { ok: true })
      const failed = line.match(/^FAIL (.+)::(.*)$/)
      if (failed !== null) reported.set(failed[1], { ok: false, error: failed[2] })
    }
    for (const path of unique) {
      const info = await pathInfo(path)
      const note = reported.get(path)
      if (!info.exists) result.recycled.push(path)
      else result.failed.push({ path, error: note?.error ?? (run.code === 0 ? 'still present after the recycle request' : `powershell exited ${run.code}`) })
    }
  } finally {
    await rm(scriptPath, { force: true }).catch(() => {})
  }
  return result
}

/**
 * Last resort when the Recycle Bin is unavailable: move the artefact next to itself under
 * a `.purge-<stamp>` name. Nothing is ever hard-deleted by this plugin.
 */
async function stageAside(path) {
  const target = `${path}.purge-${Date.now()}`
  await rename(path, target)
  return target
}

/**
 * Run `action` against this plugin's own resolved service table.
 *
 * `ctx.connection.rpc.handle()` does not register anything against the caller: inside
 * the Connection service it runs `owner.effect(() => owner.webServer.register(route))`
 * on the **Connection service's own context**. A plugin that declares `webServer` in
 * `inject` never appears in that context's dependency chain, so the registration always
 * fails with `cannot get property "webServer" without inject` — unless the service is
 * reachable from the caller's own store, which is exactly what this helper arranges.
 *
 * While `action` runs, the `connection` binding this plugin reads is a pass-through
 * proxy whose `rpc` is answered by a small registrar: it replays the framework's own
 * route construction and admits each request through the real connection service, but
 * registers the prefix route through this plugin's own `webServer`, so the route lives
 * and dies with the plugin instead of the Connection service.
 */
function registerChannel(ctx, connection, channel, handler, log) {
  // The framework's `connection.rpc.handle()` is not usable from a third-party bundle:
  // it defers the real work into `owner.effect(() => owner.webServer.register(route))`,
  // and `owner` is the Connection service's own private scope, which never binds
  // `webServer` (its store only holds webStartup/credentials/connection). Registering the
  // same prefix route through the plugin's own `webServer` avoids that scope entirely;
  // request admission still reuses `connection.admit` so the browser session is enforced.
  const webServer = serviceOf(ctx, 'webServer')
  if (webServer === undefined) throw new Error('the webServer service is not reachable')
  const route = {
    kind: 'prefix',
    path: channel,
    handler: async (req, res) => {
      let admission
      try {
        admission = typeof connection?.admit === 'function' ? connection.admit(req) : undefined
      } catch (error) {
        log.warn(`admission check failed: ${errText(error)}`)
        admission = undefined
      }
      if (admission !== undefined && admission !== null && 'rejection' in admission) {
        res.writeHead(admission.rejection, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      await bridgeRpc(req, res, channel, handler, admission?.peer, log)
    },
  }
  let disposer
  try {
    disposer = webServer.register(route)
  } catch (error) {
    // A bundle remount can briefly overlap the previous mount. The route still belongs
    // to this same plugin, so a collision means this channel is already serving.
    if (/duplicate prefix route/i.test(errText(error))) {
      log.info(`rpc route ${channel} is already attached`)
      return undefined
    }
    throw error
  }
  try {
    ctx.effect(() => disposer, `workspace-purge: ${channel} rpc route`)
  } catch (error) {
    log.warn(`route disposer not registered: ${errText(error)}`)
  }
  return disposer
}

/** Read a declared service off the plugin's own context, or undefined when not reachable. */
function serviceOf(ctx, key) {
  try {
    const value = ctx[key]
    if (value !== undefined && value !== null) return value
  } catch {
    /* fall through to the guarded lookup */
  }
  try {
    return ctx.get(key)
  } catch {
    return undefined
  }
}

/** JSON-RPC over one HTTP POST, mirroring `dsh-client-connection`'s `rpcFetchHandler` + bridge. */
async function bridgeRpc(req, res, channel, handler, peer, log) {
  const fail = (status, message) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(message)
  }
  if (req.method !== 'POST') {
    fail(405, 'method not allowed')
    return
  }
  const contentType = String(req.headers['content-type'] ?? '')
  if (!contentType.toLowerCase().startsWith('application/json')) {
    fail(415, 'content type must be application/json')
    return
  }
  const maxBytes = 8 * 1024 * 1024
  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > maxBytes) {
        fail(413, 'request body too large')
        return
      }
      chunks.push(chunk)
    }
  } catch (error) {
    fail(400, `cannot read the request body: ${errText(error)}`)
    return
  }
  let message
  try {
    message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    fail(400, 'body is not JSON')
    return
  }
  const endpoint = typeof message?.method === 'string' ? message.method : ''
  const path = channel === '/' ? String(req.url ?? '').split('?')[0] : String(req.url ?? '').startsWith(channel) ? String(req.url ?? '').slice(channel.length) : ''
  const expected = path.startsWith('/') ? path.slice(1) : path
  if (endpoint.length === 0 || expected.length === 0 || endpoint !== expected) {
    fail(404, 'unknown endpoint')
    return
  }
  let result
  try {
    result = await handler(endpoint, message?.payload, undefined, peer)
  } catch (error) {
    log.error(`channel handler threw: ${errText(error)}`)
    fail(500, `handler failure: ${errText(error)}`)
    return
  }
  const body = JSON.stringify({ type: 'server-response', rpcId: message?.rpcId, result })
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

export function apply(rawCtx, config) {
  const log = createLog(rawCtx)
  const ctx = rawCtx
  let started = false
  let deadline

  // The Loader hands the plugin its own apply, so its `inject` declaration is already
  // satisfied here; this one turn delay only makes sure the scope is fully initialised.
  const timer = setTimeout(() => {
    if (started) return
    started = true
    if (deadline !== undefined) clearTimeout(deadline)
    deadline = undefined
    try {
      startBody()
    } catch (error) {
      log.error(`apply failed: ${errText(error)}`)
    }
  }, 0)
  if (typeof timer.unref === 'function') timer.unref()

  deadline = setTimeout(() => {
    deadline = undefined
    if (started) return
    log.error('the panel channel never started')
  }, GATE_TIMEOUT_MS)
  if (typeof deadline.unref === 'function') deadline.unref()

  void config

  // ---------------------------------------------------------------------------

  function startBody() {
    const fail = (code, message, details = {}) => ({ ok: false, error: { code, message, details } })
    const done = (value) => ({ ok: true, value })

    /** Disposers collected here are released when the plugin unloads. */
    const toolDisposers = []
    const probed = new Map()

    /**
     * Resolve one service, returning undefined instead of throwing when it is absent.
     * Inside the gate the declared services are bindings (the idiomatic read); the
     * guarded `ctx.get` stays as the fallback for services that are not declared.
     */
    function service(key) {
      try {
        const binding = ctx[key]
        if (binding !== undefined && binding !== null) return binding
      } catch {
        /* not a binding here: fall through to the guarded lookup */
      }
      try {
        return ctx.get(key)
      } catch (error) {
        if (!probed.has(`missing:${key}`)) {
          probed.set(`missing:${key}`, true)
          log.warn(`service ${key} is not reachable: ${errText(error)}`)
        }
        return undefined
      }
    }

    function reportMissing() {
      const missing = REQUIRED_SERVICES.filter((key) => service(key) === undefined)
      if (missing.length > 0) log.warn(`services not reachable: ${missing.join(', ')}`)
    }

    // The channel is this plugin's only face to the Client half: register it first, and
    // never let one failing registration take the rest of the plugin down with it.
    try {
      const connection = service('connection')
      registerChannel(ctx, connection, CHANNEL, handler, log)
      log.info(`rpc channel ${CHANNEL} registered`)
    } catch (error) {
      log.error(`rpc channel ${CHANNEL} registration failed: ${errText(error)}`)
    }
    reportMissing()
    registerTool()

    /** Session header lookup that never throws: live store first, then the persistence listing. */
    async function sessionHeader(sessionId) {
      try {
        const live = service('sessions')?.get?.(sessionId)
        if (live?.header !== undefined) return live.header
      } catch {
        /* ignore */
      }
      try {
        const listed = await service('sessionPersistence')?.list?.()
        for (const snapshot of listed ?? []) {
          if (String(snapshot?.header?.id) === sessionId) return snapshot.header
        }
      } catch (error) {
        log.warn(`session listing failed while reading ${sessionId}: ${errText(error)}`)
      }
      try {
        const snapshot = await service('sessionPersistence')?.stat?.(sessionId)
        if (snapshot?.header !== undefined) return snapshot.header
      } catch {
        /* ignore */
      }
      return undefined
    }

    /** Directory names on disk are either `<id>` or `session-<id>`; find either shape. */
    async function locateByScan(sessionId) {
      const bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
      const candidates = [...new Set([sessionId, bare, `session-${bare}`])]
      const root = join(dshHome(), 'sessions')
      let slugs = []
      try {
        slugs = await readdir(root)
      } catch {
        return undefined
      }
      for (const slug of slugs) {
        if (slug.startsWith('.') === true) continue
        for (const name of candidates) {
          const dir = join(root, slug, name)
          if ((await pathInfo(dir)).exists === true) return dir
        }
      }
      return undefined
    }

    async function sessionArtifact(sessionId, header) {
      const bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
      const cwd = typeof header?.cwd === 'string' ? header.cwd : undefined
      let logPath
      try {
        const located = service('sessionPersistence')?.locate?.({ id: sessionId, cwd })
        logPath = typeof located?.path === 'string' ? located.path : undefined
      } catch {
        logPath = undefined
      }
      let dir = logPath === undefined ? undefined : join(logPath, '..')
      if (dir !== undefined && (await pathInfo(dir)).exists !== true) dir = undefined
      // locate() cannot resolve a session whose header is gone, so fall back to the log tree.
      if (dir === undefined) dir = await locateByScan(sessionId)
      let projectionPath
      for (const name of [...new Set([sessionId, bare])]) {
        const candidate = join(dshHome(), 'storages', 'session_projcache', 'sessions', `${name}.json`)
        if ((await pathInfo(candidate)).exists === true) {
          projectionPath = candidate
          break
        }
      }
      return {
        logPath,
        ...(dir === undefined ? {} : { dir }),
        ...(projectionPath === undefined ? {} : { projectionPath }),
      }
    }

    /** Read `workspace`/`session_projcache` storage directly so metadata can be pruned without services. */
    function domainTable(domainName, tableName) {
      try {
        const domain = service('storageDomain')?.get?.(domainName)
        if (domain === undefined) return undefined
        const table = domain.table?.(tableName)
        return table === undefined ? undefined : { domain, table }
      } catch {
        return undefined
      }
    }

    async function readWorkspaceGlobal() {
      try {
        return await service('storageDomain')?.get?.('workspace')?.global?.get?.()
      } catch (error) {
        log.warn(`workspace global read failed: ${errText(error)}`)
        return undefined
      }
    }

    function readIds(method, registry) {
      try {
        const value = registry?.[method]
        return Array.isArray(value) ? value.map(String) : []
      } catch {
        return []
      }
    }

    function listWorkspaces(registry) {
      try {
        const list = registry?.list?.()
        return Array.isArray(list) ? list : []
      } catch {
        return []
      }
    }

    /**
     * Drop every durable trace of a session id from the workspace domain:
     * `global.archivedSessionIds`, `global.pinnedSessionIds` and each record's `sessionIds`.
     */
    async function pruneSessionReferences(sessionId) {
      const notes = []
      const registry = service('workspaceRegistry')
      if (readIds('archivedSessionIds', registry).includes(sessionId) && typeof registry?.unarchiveSession === 'function') {
        try {
          await registry.unarchiveSession(sessionId)
        } catch (error) {
          notes.push(`unarchive: ${errText(error)}`)
        }
      }
      if (readIds('pinnedSessionIds', registry).includes(sessionId) && typeof registry?.unpinSession === 'function') {
        try {
          await registry.unpinSession(sessionId)
        } catch (error) {
          notes.push(`unpin: ${errText(error)}`)
        }
      }
      for (const workspace of listWorkspaces(registry)) {
        if (!Array.isArray(workspace?.sessionIds) || !workspace.sessionIds.includes(sessionId)) continue
        try {
          await workspace.detachSession(sessionId)
        } catch (error) {
          notes.push(`detach from ${workspace.id}: ${errText(error)}`)
        }
      }

      // Belt and braces: prune the raw domain documents too, in case a Workspace service
      // kept an id that its entity set no longer exposes.
      const workspaceTable = domainTable('workspace', 'workspaces')
      if (workspaceTable !== undefined) {
        try {
          for (const key of workspaceTable.table.keys?.() ?? []) {
            const record = workspaceTable.table.get?.(key)
            if (!Array.isArray(record?.sessionIds) || !record.sessionIds.includes(sessionId)) continue
            await workspaceTable.table.update(key, (current) => ({
              ...current,
              sessionIds: current.sessionIds.filter((id) => String(id) !== sessionId),
              updatedAt: Date.now(),
            }))
          }
        } catch (error) {
          notes.push(`workspace table prune: ${errText(error)}`)
        }
      }
      const global = await readWorkspaceGlobal()
      if (global !== undefined) {
        const archived = Array.isArray(global.archivedSessionIds) ? global.archivedSessionIds : []
        const pinned = Array.isArray(global.pinnedSessionIds) ? global.pinnedSessionIds : []
        const nextArchived = archived.filter((id) => String(id) !== sessionId)
        const nextPinned = pinned.filter((id) => String(id) !== sessionId)
        if (nextArchived.length !== archived.length || nextPinned.length !== pinned.length) {
          try {
            await service('storageDomain')?.get?.('workspace')?.global?.set?.({ ...global, archivedSessionIds: nextArchived, pinnedSessionIds: nextPinned })
          } catch (error) {
            notes.push(`workspace global prune: ${errText(error)}`)
          }
        }
      }
      return notes
    }

    async function deleteProjectionRecord(sessionId) {
      const bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
      const cache = domainTable('session_projcache', 'sessions')
      for (const key of new Set([sessionId, bare, `session-${bare}`])) {
        if (cache !== undefined) {
          try {
            await cache.table.delete(key)
          } catch (error) {
            log.warn(`projection record delete via domain failed: ${errText(error)}`)
          }
        }
        const path = join(dshHome(), 'storages', 'session_projcache', 'sessions', `${key}.json`)
        try {
          if ((await pathInfo(path)).exists) await rm(path, { force: true })
        } catch (error) {
          log.warn(`projection file remove failed: ${errText(error)}`)
        }
      }
    }

    async function stopSession(sessionId) {
      try {
        await service('workspaceRegistry')?.stopSessionActivity?.(sessionId)
      } catch (error) {
        log.warn(`stopSessionActivity(${sessionId}) failed: ${errText(error)}`)
      }
      // Interrupt a running agent as a second fence; a missing service is fine.
      try {
        if (service('agents')?.get?.(sessionId) !== undefined) {
          await service('subagents')?.interrupt?.(sessionId, { kind: 'host', reason: 'workspace-purge' })
        }
      } catch (error) {
        log.warn(`interrupt(${sessionId}) failed: ${errText(error)}`)
      }
    }

    async function detachLiveSession(sessionId) {
      const sessions = service('sessions')
      let entry
      try {
        entry = sessions?.store?.get?.(sessionId)
      } catch {
        entry = undefined
      }
      if (entry === undefined && typeof sessions?.liveEntryFor === 'function') {
        try {
          entry = sessions.liveEntryFor(sessionId)
        } catch {
          entry = undefined
        }
      }
      if (entry !== undefined && entry !== null) {
        try {
          sessions.detachEntered?.(entry)
          return true
        } catch (error) {
          log.warn(`detachEntered(${sessionId}) failed: ${errText(error)}`)
        }
        try {
          entry.detach?.()
          return true
        } catch (inner) {
          log.warn(`entry.detach(${sessionId}) failed: ${errText(inner)}`)
        }
      }
      // A running agent still holds the session log open; unload its fiber as the last fence.
      try {
        const agent = service('agents')?.get?.(sessionId)
        const fiber = agent?.ctx?.fiber
        if (fiber !== undefined && typeof fiber._unload === 'function') {
          fiber._unload()
          return true
        }
      } catch (error) {
        log.warn(`agent fiber unload(${sessionId}) failed: ${errText(error)}`)
      }
      return false
    }

    /**
     * Purge one session: stop its work, detach it, un-hang it from every workspace, then
     * move its log directory and projection record to the Recycle Bin. Nothing is ever
     * hard-deleted; a refused item is staged aside and reported.
     */
    async function purgeSession(sessionId, options) {
      const report = { sessionId, removed: false, recycled: [], staged: [], failures: [], notes: [] }
      if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
        report.failures.push('invalid session id')
        return report
      }
      if (options?.selfSessionId !== undefined && sessionId === options.selfSessionId) {
        report.failures.push('this is the conversation running the panel, so it cannot delete itself')
        return report
      }
      const header = await sessionHeader(sessionId)
      let isLive = false
      try {
        isLive = service('sessions')?.get?.(sessionId) !== undefined
      } catch {
        isLive = false
      }
      if (isLive) report.notes.push('live session stopped before removal')

      await stopSession(sessionId)
      report.detached = await detachLiveSession(sessionId)

      const artifact = await sessionArtifact(sessionId, header)
      const paths = []
      if (artifact.dir !== undefined && (await pathInfo(artifact.dir)).exists) paths.push(artifact.dir)
      if (artifact.projectionPath !== undefined) paths.push(artifact.projectionPath)

      if (paths.length > 0) {
        const recycled = await sendToRecycleBin(paths)
        report.recycled.push(...recycled.recycled)
        for (const failure of recycled.failed) {
          try {
            report.staged.push(await stageAside(failure.path))
          } catch (error) {
            report.failures.push(`${failure.path}: ${failure.error ?? errText(error)}`)
          }
        }
      }

      await deleteProjectionRecord(sessionId)
      report.notes.push(...(await pruneSessionReferences(sessionId)))
      report.removed = report.failures.length === 0
      return report
    }

    /** Guard: refuse workspace folders whose removal would take the app or unrelated data with it. */
    function folderGuard(workspace, allWorkspaces) {
      const folder = workspace?.path
      if (typeof folder !== 'string' || folder.trim().length === 0) return 'workspace has no folder path'
      if (isSamePath(folder, parsePath(resolve(folder)).root)) return 'refusing to delete a drive root'
      const forbidden = [
        ['home directory', homedir()],
        ['DSH home', dshHome()],
        ['profile directory', process.env.DSH_PROFILE_DIR],
        ['application directory', process.env.APP_ROOT],
      ]
      for (const [label, candidate] of forbidden) {
        if (typeof candidate !== 'string' || candidate.length === 0) continue
        if (isSamePath(folder, candidate)) return `refusing to delete the ${label}`
        if (isInsideOrEqual(folder, candidate)) return `refusing to delete a folder that contains the ${label}`
      }
      for (const other of allWorkspaces) {
        if (other === undefined || other.id === workspace.id) continue
        if (typeof other.path !== 'string') continue
        if (isSamePath(folder, other.path)) continue
        if (isInsideOrEqual(folder, other.path)) return `refusing to delete a folder that contains the workspace "${other.title ?? other.id}"`
      }
      if (isInsideOrEqual(join(dshHome(), 'sessions'), folder)) return 'refusing to delete a folder that holds the session logs'
      return undefined
    }

    /** The durable Workspace record, independent of the live entity set. */
    function workspaceRecord(workspaceId) {
      try {
        return domainTable('workspace', 'workspaces')?.table?.get?.(workspaceId)
      } catch {
        return undefined
      }
    }

    async function purgeWorkspace(workspaceId, request) {
      const registry = service('workspaceRegistry')
      const report = { workspaceId, removed: false, sessions: [], folderRecycled: false, failures: [], notes: [] }
      // Resolve the record, not only the live entity: the entity set drops an id whose
      // stored record vanished, and this step must still report why it cannot proceed.
      const workspace = workspaceRecord(workspaceId) ?? registry?.get?.(workspaceId)
      if (workspace === undefined || workspace === null) {
        report.failures.push('workspace is not registered')
        return report
      }
      if (typeof workspace.title === 'string') report.title = workspace.title
      if (typeof workspace.path === 'string') report.folder = workspace.path

      const ids = Array.isArray(workspace.sessionIds) ? [...workspace.sessionIds] : []
      for (const sessionId of ids) {
        if (sessionId === request?.selfSessionId) {
          report.notes.push(`kept the running conversation ${sessionId}`)
          continue
        }
        report.sessions.push(await purgeSession(sessionId, request))
      }

      // Remove the registration last: while it is still registered the Workspace keeps
      // serving its order state, and its sessions are already gone by now.
      let removed = false
      try {
        removed = (await registry.delete(workspaceId)) === true
      } catch (error) {
        report.failures.push(`workspace registration: ${errText(error)}`)
      }
      if (removed) report.notes.push('workspace registration removed')

      if (request?.deleteFolders === true) {
        report.folderRequested = true
        const guard = folderGuard(workspace, listWorkspaces(registry))
        if (guard !== undefined) {
          report.failures.push(guard)
        } else {
          const confirm = typeof request?.folderConfirms?.[workspaceId] === 'string' ? request.folderConfirms[workspaceId] : ''
          const expected = resolve(report.folder).replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
          if (confirm.trim().toLowerCase() !== expected.toLowerCase()) {
            report.failures.push(`folder confirmation "${confirm}" does not match "${expected}"`)
          } else {
            const info = await pathInfo(report.folder)
            if (!info.exists) report.notes.push('folder already absent')
            else if (!info.isDirectory) report.failures.push('workspace path is not a directory')
            else {
              const recycled = await sendToRecycleBin([report.folder])
              if (recycled.recycled.length > 0) report.folderRecycled = true
              else {
                try {
                  report.folderStaged = await stageAside(report.folder)
                } catch (error) {
                  report.failures.push(`${report.folder}: ${recycled.failed[0]?.error ?? errText(error)}`)
                }
              }
            }
          }
        }
      }

      report.removed = removed || report.failures.length === 0
      return report
    }

    /**
     * Titles live in the projection cache (`record.rows.title.val`); the sidebar shows
     * them, so the panel shows the same text. File names are `<id>` or `session-<id>`.
     */
    async function projectionIndex() {
      const map = new Map()
      const dir = join(dshHome(), 'storages', 'session_projcache', 'sessions')
      let names = []
      try {
        names = await readdir(dir)
      } catch {
        return map
      }
      await Promise.all(
        names
          .filter((entry) => entry.endsWith('.json'))
          .map(async (entry) => {
            const id = entry.slice(0, -'.json'.length)
            try {
              const parsed = JSON.parse(await readFile(join(dir, entry), 'utf8'))
              const value = parsed?.record?.rows?.title?.val
              if (typeof value === 'string' && value.trim().length > 0) map.set(id, value.trim())
            } catch {
              /* a corrupt projection simply has no cached title */
            }
          }),
      )
      return map
    }

    /**
     * Session log directories on disk. A session removed through the shipped UI can keep
     * its log while losing every registration, and that is the empty "unnamed" row the
     * sidebar leaves behind.
     */
    async function diskIndex() {
      const map = new Map()
      const root = join(dshHome(), 'sessions')
      let slugs = []
      try {
        slugs = await readdir(root)
      } catch {
        return map
      }
      for (const slug of slugs) {
        if (slug.startsWith('.') === true) continue
        let entries = []
        try {
          entries = await readdir(join(root, slug), { withFileTypes: true })
        } catch {
          continue
        }
        for (const entry of entries) {
          if (entry.isDirectory() !== true) continue
          if (entry.name.startsWith('.') === true) continue
          map.set(entry.name, slug)
        }
      }
      return map
    }

    /** Everything the panel needs: workspaces with their sessions, plus archived sessions. */
    async function snapshot() {
      const registry = service('workspaceRegistry')
      const titleService = service('sessionTitle')
      const headers = new Map()
      let listing = []
      try {
        listing = (await service('sessionPersistence')?.list?.()) ?? []
      } catch (error) {
        log.warn(`session listing failed: ${errText(error)}`)
      }
      for (const entry of listing) {
        const header = entry?.header
        if (header?.id === undefined) continue
        headers.set(String(header.id), {
          cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
          createdAt: header.createdAt,
          agentPreset: header.agentPreset,
          sizeBytes: entry?.sizeBytes,
          path: typeof entry?.path === 'string' ? entry.path : undefined,
        })
      }

      const projections = await projectionIndex()

      /** Header lookup tolerant of the `session-` prefix difference between id shapes. */
      const headerOf = (sessionId) => {
        const bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
        return headers.get(sessionId) ?? headers.get(bare) ?? headers.get(`session-${bare}`)
      }

      const titleOf = (sessionId) => {
        const bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
        const cached = projections.get(sessionId) ?? projections.get(bare) ?? projections.get(`session-${bare}`)
        if (typeof cached === 'string') return cached
        try {
          const live = service('sessions')?.get?.(sessionId)
          if (live !== undefined && titleService !== undefined) {
            const titled = titleService?.get?.(live)
            if (typeof titled?.title === 'string' && titled.title.length > 0) return titled.title
          }
        } catch {
          /* ignore */
        }
        return undefined
      }

      const liveIds = new Set()
      try {
        for (const session of service('sessions')?.list?.() ?? []) liveIds.add(String(session.id))
      } catch {
        /* ignore */
      }

      const describe = (sessionId) => {
        const meta = headerOf(sessionId) ?? {}
        const title = titleOf(sessionId) ?? meta.title
        return {
          id: sessionId,
          ...(title === undefined ? {} : { title }),
          ...(meta.cwd === undefined ? {} : { cwd: meta.cwd }),
          ...(meta.createdAt === undefined ? {} : { createdAt: meta.createdAt }),
          live: liveIds.has(sessionId),
          onDisk: meta.path !== undefined,
        }
      }

      const workspaces = []
      const grouped = new Set()
      for (const workspace of listWorkspaces(registry)) {
        const folderInfo = await pathInfo(workspace.path)
        const sessions = []
        for (const sessionId of Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []) {
          grouped.add(String(sessionId))
          sessions.push(describe(String(sessionId)))
        }
        workspaces.push({
          id: String(workspace.id),
          title: workspace.title,
          path: workspace.path,
          folderExists: folderInfo.exists,
          folderIsDirectory: folderInfo.isDirectory,
          sessions,
        })
      }

      const archivedIds = readIds('archivedSessionIds', registry).map(String)
      const archived = archivedIds.filter((id) => !grouped.has(id)).map(describe)

      // Sessions with a projection or a log directory that no workspace owns are the
      // leftover "unnamed" rows; the panel lists them so they can really be removed.
      const disk = await diskIndex()
      const known = new Set([...grouped, ...archivedIds])
      const seen = new Set()
      const orphans = []
      const consider = (key) => {
        const bare = key.startsWith('session-') ? key.slice('session-'.length) : key
        const candidates = [key, bare, `session-${bare}`]
        if (candidates.some((value) => known.has(value))) return
        if (candidates.some((value) => seen.has(value))) return
        for (const value of candidates) seen.add(value)
        orphans.push(describe(`session-${bare}`))
      }
      for (const key of projections.keys()) consider(key)
      for (const key of disk.keys()) consider(key)
      orphans.sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))

      return {
        platform: process.platform,
        supportsRecycleBin: process.platform === 'win32',
        workspaces,
        archived,
        orphans,
        sessionCount: headers.size,
        pinned: readIds('pinnedSessionIds', registry),
      }
    }

    const handlers = {
      async list() {
        return done(await snapshot())
      },

      async deleteSessions(payload) {
        const ids = Array.isArray(payload?.sessionIds) ? payload.sessionIds.map(String) : []
        if (ids.length === 0) return fail('bad-request', 'no session ids supplied')
        const reports = []
        for (const sessionId of ids) reports.push(await purgeSession(sessionId, { selfSessionId: payload?.selfSessionId }))
        const failures = reports.flatMap((report) => report.failures.map((failure) => `${report.sessionId}: ${failure}`))
        return done({ reports, failures })
      },

      async deleteWorkspaces(payload) {
        const ids = Array.isArray(payload?.workspaceIds) ? payload.workspaceIds.map(String) : []
        if (ids.length === 0) return fail('bad-request', 'no workspace ids supplied')
        const reports = []
        for (const workspaceId of ids) {
          reports.push(
            await purgeWorkspace(workspaceId, {
              selfSessionId: payload?.selfSessionId,
              deleteFolders: payload?.deleteFolders === true,
              folderConfirms: payload?.folderConfirms ?? {},
            }),
          )
        }
        const failures = reports.flatMap((report) => report.failures.map((failure) => `${report.workspaceId}: ${failure}`))
        return done({ reports, failures })
      },
    }

    async function handler(endpoint, payload) {
      const fn = handlers[endpoint]
      if (fn === undefined) return fail('not-found', `unknown endpoint ${JSON.stringify(endpoint)}`)
      try {
        return await fn(payload ?? {})
      } catch (error) {
        log.error(`${endpoint} failed: ${errText(error)}`)
        return fail('internal', errText(error))
      }
    }

    /** Register the agent tool; it calls the same handlers as the panel, so the two cannot drift. */
    function registerTool() {
      try {
        const dispose = service('tools')?.register?.({
          name: 'workspace_purge',
          description:
            'List, or permanently delete, conversations and workspaces of this Harness profile. ' +
            'Deleting a conversation moves its session log and projection cache to the Windows Recycle Bin; ' +
            'deleting a workspace also removes its registration and, only with deleteFolders=true plus a matching folder name, the folder itself.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              action: { type: 'string', enum: ['list', 'delete-sessions', 'delete-workspaces'], description: 'Operation to perform.' },
              sessionIds: { type: 'array', items: { type: 'string' }, description: 'Session ids for delete-sessions.' },
              workspaceIds: { type: 'array', items: { type: 'string' }, description: 'Workspace ids for delete-workspaces.' },
              deleteFolders: { type: 'boolean', description: 'Move the workspace folder to the Recycle Bin too.' },
              folderConfirms: {
                type: 'object',
                additionalProperties: { type: 'string' },
                description: 'Map of workspace id to the folder name typed by the user, required when deleteFolders is true.',
              },
            },
            required: ['action'],
          },
          // A tool must declare its result shape; the JSON report is rendered as one text block.
          output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
          },
          async execute(input) {
            const action = input?.action
            if (action === 'list') return await handlers.list({})
            if (action === 'delete-sessions') return await handlers.deleteSessions({ sessionIds: input?.sessionIds })
            if (action === 'delete-workspaces') {
              return await handlers.deleteWorkspaces({
                workspaceIds: input?.workspaceIds,
                deleteFolders: input?.deleteFolders === true,
                folderConfirms: input?.folderConfirms,
              })
            }
            return fail('bad-request', `unknown action ${JSON.stringify(action)}`)
          },
        })
        if (typeof dispose === 'function') toolDisposers.push(dispose)
      } catch (error) {
        log.warn(`tool registration skipped: ${errText(error)}`)
      }
    }

    return () => {
      for (const dispose of toolDisposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* cleanup only */
        }
      }
    }
  }
}

/**
 * The apply-scope logger. It reaches the cordis logger without an undeclared property
 * read: cordis answers an undeclared read with the very error this plugin reports.
 */
function createLog(ctx) {
  let logger
  try {
    logger = ctx?.logger
  } catch {
    logger = undefined
  }
  const emit = (level, message) => {
    try {
      if (typeof logger?.[level] === 'function') logger[level](message)
    } catch {
      /* logging must never break the plugin */
    }
  }
  return {
    info: (message) => emit('info', message),
    warn: (message) => emit('warn', message),
    error: (message) => emit('error', message),
  }
}

export const __internal = { isSamePath, isInsideOrEqual, quotePs, recycle: sendToRecycleBin }