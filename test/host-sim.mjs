/**
 * Offline harness for the Host half: drives `apply()` with fake platform services so the
 * purge sequence, the folder guards and the RPC envelope can be exercised without a live
 * Harness. Run with `node test/host-sim.mjs`.
 */
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const sandboxRoot = await mkdtemp(join(tmpdir(), 'wspurge-sim-'))
process.env.DSH_HOME = join(sandboxRoot, 'dsh-home')

const home = process.env.DSH_HOME
const projectDir = join(home, 'sessions', '--D-sim-project--')
const sessionA = 'session-aaaa1111-2222-3333-4444-555566667777'
const sessionB = 'session-bbbb1111-2222-3333-4444-555566667777'
const selfSession = 'session-self-0000-2222-3333-4444-555566667777'
const workspaceDir = join(sandboxRoot, 'project')
const otherDir = join(sandboxRoot, 'other-project')

for (const id of [sessionA, sessionB, selfSession]) {
  await mkdir(join(projectDir, id), { recursive: true })
  await writeFile(join(projectDir, id, 'session.v4.jsonl.zstd'), 'stub')
  await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  await writeFile(join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`), '{}')
}
await mkdir(workspaceDir, { recursive: true })
await mkdir(otherDir, { recursive: true })
await writeFile(join(workspaceDir, 'notes.md'), 'hello')

/* ---- fake platform ------------------------------------------------------- */
const calls = []
const records = {
  'ws-main': { path: workspaceDir, title: 'Main', sessionIds: [sessionA, sessionB, selfSession], createdAt: 1, updatedAt: 1 },
  'ws-other': { path: otherDir, title: 'Other', sessionIds: [], createdAt: 2, updatedAt: 2 },
}
const globalState = { initialized: true, defaultWorkspaceId: 'ws-main', workspaceIds: ['ws-main', 'ws-other'], archivedSessionIds: [sessionA], pinnedSessionIds: [sessionB] }
const table = {
  keys: () => Object.keys(records),
  get: (key) => (records[key] === undefined ? undefined : structuredClone(records[key])),
  update: async (key, fn) => {
    records[key] = fn(structuredClone(records[key]))
    calls.push(['table.update', key])
    return records[key]
  },
  delete: async (key) => {
    delete records[key]
    return true
  },
}
const openDomain = (name) => ({
  table: (tableName) => (name === 'workspace' && tableName === 'workspaces' ? table : name === 'session_projcache' ? { delete: async (key) => { calls.push(['projcache.delete', key]) } } : undefined),
  global: {
    get: async () => structuredClone(globalState),
    set: async (value) => {
      Object.assign(globalState, value)
      calls.push(['global.set'])
    },
  },
})

const liveStore = new Map([[sessionB, { id: sessionB, header: { id: sessionB, cwd: workspaceDir } }]])
const workspaceEntities = Object.keys(records).map((id) => ({
  id,
  get path() {
    return records[id]?.path
  },
  get title() {
    return records[id]?.title
  },
  get sessionIds() {
    return records[id]?.sessionIds ?? []
  },
  detachSession: async (sessionId) => {
    records[id].sessionIds = records[id].sessionIds.filter((entry) => entry !== sessionId)
    calls.push(['detachSession', id, sessionId])
  },
}))

const registry = {
  list: () => workspaceEntities.filter((entity) => records[entity.id] !== undefined),
  get: (id) => workspaceEntities.find((entity) => entity.id === id),
  delete: async (id) => {
    if (records[id] === undefined) return false
    delete records[id]
    globalState.workspaceIds = globalState.workspaceIds.filter((entry) => entry !== id)
    calls.push(['registry.delete', id])
    return true
  },
  stopSessionActivity: async (sessionId) => calls.push(['stop', sessionId]),
  archiveSession: async () => {},
  unarchiveSession: async (sessionId) => {
    globalState.archivedSessionIds = globalState.archivedSessionIds.filter((id) => id !== sessionId)
    calls.push(['unarchive', sessionId])
  },
  unpinSession: async (sessionId) => {
    globalState.pinnedSessionIds = globalState.pinnedSessionIds.filter((id) => id !== sessionId)
    calls.push(['unpin', sessionId])
  },
  get archivedSessionIds() {
    return globalState.archivedSessionIds
  },
  get pinnedSessionIds() {
    return globalState.pinnedSessionIds
  },
}

const persistence = {
  list: async () => [
    { header: { id: sessionA, cwd: workspaceDir, createdAt: 10 }, sizeBytes: 4 },
    { header: { id: sessionB, cwd: workspaceDir, createdAt: 20 }, sizeBytes: 4 },
    { header: { id: selfSession, cwd: workspaceDir, createdAt: 30 }, sizeBytes: 4 },
  ],
  stat: async (id) => ({ header: { id } }),
  locate: ({ id }) => ({ kind: 'jsonl', path: join(projectDir, id, 'session.v4.jsonl.zstd') }),
}

const sessions = {
  store: liveStore,
  get: (id) => liveStore.get(id)?.session,
  list: () => [...liveStore.values()].map((entry) => entry.session ?? { id: entry.id, header: entry.header }),
  detachEntered: (entry) => {
    liveStore.delete(entry.id)
    calls.push(['detachEntered', entry.id])
  },
}

const services = {
  webServer: {
    register: (route) => {
      services.__route = route
      return () => {}
    },
  },
  connection: { rpc: { handle: (channel, fn) => { services.__channel = channel; services.__handler = fn } }, admit: () => ({ peer: undefined }) },
  workspaceRegistry: registry,
  sessionPersistence: persistence,
  storageDomain: { get: openDomain },
  sessions,
  tools: { register: (definition) => { services.__tool = definition } },
  logger: { info: () => {}, warn: (m) => calls.push(['warn', m]), error: (m) => calls.push(['error', m]) },
}

const ctx = {
  get: (key) => services[key],
  // The real Context gates every service behind inject: the callback receives the same
  // fiber context with the declared bindings promoted to properties.
  inject: (names, callback) => callback(ctx),
  // A stand-in for cordis's resolved-service table: the plugin retargets one entry while
  // it registers its channel, so the fake connection service can be reached that way.
  fiber: {
    store: new Proxy(
      {},
      {
        get: (target, key) => target[key] ?? (services[key] === undefined ? undefined : { name: key, value: services[key] }),
      },
    ),
  },
  get connection() { return services.connection },
  get webServer() { return services.webServer },
  get workspaceRegistry() { return services.workspaceRegistry },
  get sessionPersistence() { return services.sessionPersistence },
  get storageDomain() { return services.storageDomain },
  get sessions() { return services.sessions },
  get tools() { return services.tools },
  get logger() { return services.logger },
  effect: (fn) => fn(),
  on: () => () => {},
}

const mod = await import('../index.js')
mod.apply(ctx, {})
// The body starts one turn after apply() so every declaration exists before the channel
// registers (see startBody / wire in index.js).
await new Promise((done) => setTimeout(done, 10))
assert.equal(services.__route?.path, '/dsh-workspace-purge', 'rpc route registered')
assert.equal(services.__route?.kind, 'prefix', 'rpc route is a prefix route')
assert.ok(services.__tool !== undefined, 'agent tool registered')

/**
 * Drive the registered HTTP route with the same envelope the Client's
 * `connection.rpc.call` sends, and unwrap the `{ok, value|error}` result — exactly what a
 * browser request would get back.
 */
async function handler(endpoint, payload) {
  const body = JSON.stringify({ type: 'client-request', rpcId: 'sim-1', method: endpoint, payload })
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers ?? {}
    },
    end(text) {
      this.body = text ?? ''
    },
  }
  const req = {
    method: 'POST',
    url: `/dsh-workspace-purge/${endpoint}`,
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body)
    },
  }
  await services.__route.handler(req, res)
  return JSON.parse(res.body).result
}

/* ---- assertions ---------------------------------------------------------- */
const list = await handler('list', {})
assert.equal(list.ok, true)
assert.equal(list.value.workspaces.length, 2)
assert.equal(list.value.archived.length, 0, 'archived session still belongs to a workspace, so it is not listed twice')

// Refuses its own conversation.
const self1 = await handler('deleteSessions', { sessionIds: [selfSession], selfSessionId: selfSession })
assert.equal(self1.ok, true)
assert.equal(self1.value.reports[0].removed, false)
assert.match(self1.value.reports[0].failures[0], /cannot delete itself|currently/i, self1.value.reports[0].failures[0])

// Refuses an unknown workspace.
const unknown = await handler('deleteWorkspaces', { workspaceIds: ['nope'] })
assert.match(unknown.value.failures[0], /not registered/)

// A guarded folder: the DSH home must never be recycled as a workspace folder.
records['ws-home'] = { path: home, title: 'Home', sessionIds: [], createdAt: 3, updatedAt: 3 }
globalState.workspaceIds.push('ws-home')
workspaceEntities.push({ id: 'ws-home', get path() { return home }, get title() { return 'Home' }, sessionIds: [], detachSession: async () => {} })
const guarded = await handler('deleteWorkspaces', { workspaceIds: ['ws-home'], deleteFolders: true, folderConfirms: { 'ws-home': 'dsh-home' } })
assert.equal(guarded.ok, true)
assert.match(guarded.value.failures.join(' '), /refusing to delete/, `${guarded.value.reports[0].failures} / ${guarded.value.reports[0].notes}`)
assert.equal(records['ws-home'], undefined, 'registration still removed')

// Session purge on a live session: stop → detach → recycle artefacts.
const gone = await handler('deleteSessions', { sessionIds: [sessionB] })
const report = gone.value.reports[0]
assert.equal(report.removed, true, JSON.stringify(report))
assert.ok(calls.some((entry) => entry[0] === 'stop' && entry[1] === sessionB), 'stopSessionActivity called')
assert.ok(calls.some((entry) => entry[0] === 'detachEntered' && entry[1] === sessionB), 'live session detached')
assert.ok(calls.some((entry) => entry[0] === 'unpin' && entry[1] === sessionB), 'unpinned')
assert.ok(calls.some((entry) => entry[0] === 'projcache.delete' && entry[1] === sessionB), 'projection record deleted')
const stillThere = await stat(join(projectDir, sessionB)).then(() => true, () => false)
assert.equal(stillThere, false, 'session directory left the tree')
assert.equal(globalState.pinnedSessionIds.includes(sessionB), false)

// Archived session gets unarchived before removal.
const archivedGone = await handler('deleteSessions', { sessionIds: [sessionA] })
assert.equal(archivedGone.value.reports[0].removed, true, JSON.stringify(archivedGone.value.reports[0]))
assert.ok(calls.some((entry) => entry[0] === 'unarchive' && entry[1] === sessionA))
assert.equal(globalState.archivedSessionIds.length, 0)
assert.ok(calls.some((entry) => entry[0] === 'detachSession' && entry[1] === 'ws-main' && entry[2] === sessionA))

// Workspace purge without the folder: registration gone, folder intact.
const wsGone = await handler('deleteWorkspaces', { workspaceIds: ['ws-other'] })
assert.equal(wsGone.value.reports[0].removed, true, JSON.stringify(wsGone.value.reports[0]))
assert.ok(calls.some((entry) => entry[0] === 'registry.delete' && entry[1] === 'ws-other'))
const otherStillThere = await stat(otherDir).then(() => true, () => false)
assert.equal(otherStillThere, true, 'folder kept when not requested')

// Folder confirmation mismatch is refused, matching is accepted.
records['ws-main'].title = 'Main'
const mismatch = await handler('deleteWorkspaces', { workspaceIds: ['ws-main'], deleteFolders: true, folderConfirms: { 'ws-main': 'typo' } })
assert.match(mismatch.value.failures.join(' '), /does not match/)
assert.equal(records['ws-main'], undefined, 'registration removed before the folder step')
const kept = await stat(workspaceDir).then(() => true, () => false)
assert.equal(kept, true, 'a mismatched folder name is never deleted')

// Same workspace folder, correct name: recycled (or staged when the Recycle Bin is absent).
records['ws-other'] = { path: otherDir, title: 'Other', sessionIds: [], createdAt: 2, updatedAt: 2 }
globalState.workspaceIds.push('ws-other')
const folderRun = await handler('deleteWorkspaces', {
  workspaceIds: ['ws-other'],
  deleteFolders: true,
  folderConfirms: { 'ws-other': 'other-project' },
})
const folderReport = folderRun.value.reports[0]
assert.equal(folderReport.removed, true, JSON.stringify(folderReport))
assert.ok(folderReport.folderRecycled === true || typeof folderReport.folderStaged === 'string', JSON.stringify(folderReport))
const folderGone = await stat(otherDir).then(() => true, () => false)
assert.equal(folderGone, false, 'confirmed folder left the tree')

// Self-protection: never the run's own conversation, and never an id that is not a session id.
const selfWrite = await handler('deleteSessions', { sessionIds: [selfSession], selfSessionId: selfSession })
assert.equal(selfWrite.value.reports[0].removed, false)
const bogus = await handler('deleteSessions', { sessionIds: ['../../etc/passwd'] })
assert.equal(bogus.value.reports[0].removed, false)
assert.match(bogus.value.reports[0].failures[0], /invalid session id/)
const unknownEndpoint = await handler('nope', {})
assert.equal(unknownEndpoint.ok, false)
assert.equal(unknownEndpoint.error.code, 'not-found')
const badRequest = await handler('deleteSessions', { sessionIds: [] })
assert.equal(badRequest.error.code, 'bad-request')
assert.equal(services.__tool.name, 'workspace_purge')
assert.ok(Array.isArray(services.__tool.parameters.required) && services.__tool.parameters.required.includes('action'))

console.log('host simulation passed')
console.log('calls:', calls.map((entry) => entry.join(':')).join('\n       '))
await rm(sandboxRoot, { recursive: true, force: true })