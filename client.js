/**
 * Client half of dsh-workspace-purge.
 *
 * Registers one Sidebar footer action that opens a management panel listing every
 * Workspace with its conversations, plus archived conversations. Rows can be deleted
 * individually or in bulk; both go through the package's private Host RPC channel, so
 * the panel and the `workspace_purge` agent tool share one implementation.
 *
 * The panel is drawn with the platform tokens and a self-contained stylesheet; it
 * deliberately imports no Harness Client package, so a platform upgrade can never blank
 * the sidebar seat.
 */
window.__ModuleLoader__.load({
  id: 'dsh-workspace-purge',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback } = React
    const NS = 'workspacePurge'
    const CHANNEL = '/dsh-workspace-purge'
    const STYLE_ID = 'dsh-workspace-purge'
    const LOCALE_EN = {
      "action": {
        "label": "Delete data",
        "tooltip": "Permanently delete conversations and workspaces"
      },
      "panel": {
        "title": "Permanently delete conversations and workspaces",
        "description": "Deleted session logs and projection caches go to the Windows Recycle Bin, so they leave the sidebar immediately and can still be restored. Workspace folders are only removed when you explicitly tick them.",
        "loading": "Loading…",
        "refresh": "Reload",
        "close": "Close",
        "workspaces": "Workspaces",
        "archived": "Archived conversations",
        "orphans": "Unassigned conversations",
        "untitled": "Untitled",
        "empty": "Nothing to delete.",
        "noSessions": "No conversations",
        "recycleNote": "Removed items go to the Recycle Bin.",
        "selectAll": "Select all",
        "clear": "Clear",
        "deleteSelected": "Delete selected ({count})",
        "deleteSession": "Delete",
        "deleteWorkspace": "Delete",
        "current": "Current conversation",
        "confirmTitle": "Permanently delete selected items?",
        "confirmBody": "The following items will be removed from the sidebar and moved to the Recycle Bin:",
        "confirmSessions": "{count} conversation(s)",
        "confirmWorkspaces": "{count} workspace(s)",
        "confirmFolders": "Their workspace folders will be deleted as well:",
        "typeFolderHint": "Type the folder name “{name}” to confirm deleting it from disk.",
        "folderMismatch": "The typed folder name does not match.",
        "confirm": "Delete permanently",
        "cancel": "Cancel",
        "working": "Deleting…",
        "done": "Done: {sessions} conversation(s) and {workspaces} workspace(s) deleted.",
        "partial": "Finished with problems. Some items were not deleted.",
        "errorTitle": "Deletion failed",
        "folderOption": "Also delete the workspace folder from disk (moves to the Recycle Bin)",
        "folderUnavailable": "The workspace folder is already missing.",
        "liveWarning": "Running, waiting to be confirmed"
      },
      "status": {
        "ok": "Deleted",
        "error": "Failed"
      }
    }
    const LOCALE_ZH = {
      "action": {
        "label": "删除数据",
        "tooltip": "彻底删除对话与工作区"
      },
      "panel": {
        "title": "彻底删除对话与工作区",
        "description": "被删除的会话日志与投影缓存会移入 Windows 回收站，因此侧栏立即消失，但仍可在回收站恢复；工作区目录只有在你明确勾选后才会被删除。",
        "loading": "正在加载…",
        "refresh": "重新加载",
        "close": "关闭",
        "workspaces": "工作区",
        "archived": "已归档的对话",
        "orphans": "未归入任何工作区的对话",
        "untitled": "未命名",
        "empty": "没有可删除的内容。",
        "noSessions": "无对话",
        "recycleNote": "被删除的项目会进入回收站。",
        "selectAll": "全选",
        "clear": "清空选择",
        "deleteSelected": "删除所选（{count}）",
        "deleteSession": "删除",
        "deleteWorkspace": "删除",
        "current": "当前对话",
        "confirmTitle": "确定要彻底删除所选内容吗？",
        "confirmBody": "以下内容将从侧栏移除并移入回收站：",
        "confirmSessions": "{count} 个对话",
        "confirmWorkspaces": "{count} 个工作区",
        "confirmFolders": "同时还会删除这些工作区目录：",
        "typeFolderHint": "请输入目录名“{name}”以确认从磁盘删除。",
        "folderMismatch": "输入的目录名不一致。",
        "confirm": "彻底删除",
        "cancel": "取消",
        "working": "正在删除…",
        "done": "完成：已删除 {sessions} 个对话、{workspaces} 个工作区。",
        "partial": "操作完成，但存在未删除的项目。",
        "errorTitle": "删除失败",
        "folderOption": "同时删除工作区目录（移入回收站）",
        "folderUnavailable": "工作区目录已不存在。",
        "liveWarning": "正在运行 / 等待确认"
      },
      "status": {
        "ok": "已删除",
        "error": "失败"
      }
    }

    const CSS = `
.wspurge-trigger{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:0;height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer}
.wspurge-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.wspurge-trigger:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}
.wspurge-trigger[data-wide="false"]{width:28px;padding:0}
.wspurge-trigger-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wspurge-root{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px}
.wspurge-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-overlay,rgba(0,0,0,.4));backdrop-filter:blur(2px)}
.wspurge-dialog{position:relative;display:flex;flex-direction:column;width:min(780px,100%);max-height:min(780px,100%);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,14px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 16px 48px rgba(0,0,0,.28);overflow:hidden}
.wspurge-dialog[data-size="small"]{width:min(520px,100%);max-height:none}
.wspurge-head{display:flex;align-items:flex-start;gap:12px;padding:18px 20px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.wspurge-head-text{flex:1;min-width:0}
.wspurge-title{margin:0;font-size:15px;font-weight:600;line-height:1.4}
.wspurge-desc{margin:6px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.wspurge-close{flex:none;width:26px;height:26px;border:0;border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-secondary);font-size:15px;line-height:1;cursor:pointer}
.wspurge-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.wspurge-body{flex:1;min-height:120px;overflow:auto;padding:12px 20px}
.wspurge-foot{display:flex;align-items:center;gap:8px;padding:12px 20px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.wspurge-foot-note{display:flex;flex:1;align-items:center;gap:4px;min-width:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.wspurge-group{margin:0 0 16px}
.wspurge-group-title{display:flex;align-items:baseline;gap:8px;margin:0 0 6px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.wspurge-path{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:400;color:var(--dsw-alias-label-tertiary)}
.wspurge-row{display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:var(--dsw-radius-md,8px)}
.wspurge-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wspurge-row[data-kind="workspace"]{margin-top:4px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1);border-radius:0}
.wspurge-row-main{flex:1;min-width:0}
.wspurge-row-title{display:flex;align-items:center;gap:6px;min-width:0;font-size:13px;line-height:1.45}
.wspurge-row-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wspurge-row-meta{margin-top:2px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wspurge-tag{flex:none;padding:1px 6px;border-radius:999px;font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-3)}
.wspurge-tag[data-kind="live"]{color:var(--dsw-alias-state-warn-primary)}
.wspurge-check{flex:none;width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.wspurge-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap}
.wspurge-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.wspurge-btn:disabled{cursor:not-allowed;opacity:.5}
.wspurge-btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}
.wspurge-btn[data-variant="primary"]{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-brand-text)}
.wspurge-btn[data-variant="primary"]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.wspurge-btn[data-variant="danger"]{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:#fff}
.wspurge-btn[data-variant="danger"]:hover:not(:disabled){filter:brightness(1.08)}
.wspurge-btn[data-variant="link"]{height:24px;padding:0 6px;border:0;background:transparent;color:var(--dsw-alias-label-secondary)}
.wspurge-btn[data-variant="link"]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.wspurge-empty{display:flex;align-items:center;justify-content:center;gap:8px;min-height:120px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.wspurge-fold{margin:6px 0 0 24px;padding:8px 10px;border:1px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);font-size:12px;line-height:1.6}
.wspurge-fold label{display:flex;align-items:flex-start;gap:8px;cursor:pointer}
.wspurge-input{width:100%;margin-top:6px;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.wspurge-input:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}
.wspurge-warn{padding:6px 10px;margin:0 0 10px;border-radius:var(--dsw-radius-md,8px);font-size:12px;line-height:1.6;color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}
.wspurge-note{padding:6px 8px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.wspurge-spin{display:inline-block;width:12px;height:12px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:wspurge-spin .8s linear infinite}
.wspurge-toast{position:fixed;left:16px;bottom:16px;z-index:2147483001;max-width:min(420px,100%);padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 8px 24px rgba(0,0,0,.2);font-size:12px;line-height:1.6;white-space:pre-wrap}
.wspurge-toast[data-kind="error"]{color:var(--dsw-alias-state-error-primary)}
@keyframes wspurge-spin{to{transform:rotate(360deg)}}
`

    /** Host RPC envelope → thrown Error keeps components free of `ok` plumbing. */
    async function rpc(ctx, endpoint, payload, signal) {
      const connection = ctx.get('connection')
      if (connection?.rpc?.call === undefined) throw new Error('连接服务不可用 / connection rpc unavailable')
      const result = await connection.rpc.call(CHANNEL, endpoint, payload ?? {}, signal)
      if (result !== null && typeof result === 'object' && 'ok' in result) {
        if (result.ok !== true) {
          const error = result.error ?? {}
          const failure = new Error(typeof error.message === 'string' ? error.message : 'request failed')
          failure.code = error.code
          failure.details = error.details
          throw failure
        }
        return result.value
      }
      return result
    }

    /** The conversation shown in the main view; it must never be deleted by this panel. */
    function currentSessionId(ctx) {
      try {
        const list = ctx.sessions?.list?.getSnapshot?.()
        const rows = list?.byId ?? {}
        for (const row of Object.values(rows)) {
          if ((row?.retainedBy?.mainView ?? 0) > 0) return row.id
        }
      } catch {
        /* ignore */
      }
      return undefined
    }

    function formatTime(value, locale) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return ''
      try {
        return new Date(value).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      } catch {
        return ''
      }
    }

    function baseName(path) {
      const parts = String(path ?? '').split(/[\\/]+/).filter((part) => part.length > 0)
      return parts.length === 0 ? '' : parts[parts.length - 1]
    }

    function IconTrash(props) {
      return h(
        'svg',
        { width: props?.size ?? 14, height: props?.size ?? 14, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.6 4.5l.6 8.1a1 1 0 0 0 1 .9h3.6a1 1 0 0 0 1-.9l.6-8.1',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function Spinner() {
      return h('span', { className: 'wspurge-spin', 'aria-hidden': 'true' })
    }

    /** Modal behaviour mirroring a platform dialog: Escape/mask close, focus in and back out. */
    function Dialog({ title, description, onClose, children, footer, small, labelledBy, closable }) {
      const surfaceRef = useRef(null)
      const returnFocusRef = useRef(null)
      const closeRef = useRef(onClose)
      closeRef.current = onClose
      useEffect(() => {
        returnFocusRef.current = document.activeElement
        const surface = surfaceRef.current
        try {
          ;(surface?.querySelector('[data-autofocus="true"]') ?? surface)?.focus?.()
        } catch {
          /* ignore */
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            closeRef.current()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          try {
            returnFocusRef.current?.focus?.()
          } catch {
            /* ignore */
          }
        }
      }, [])
      return h(
        'div',
        { className: 'wspurge-root', role: 'presentation' },
        h('div', { className: 'wspurge-mask', 'aria-hidden': 'true', onClick: onClose }),
        h(
          'div',
          {
            ref: surfaceRef,
            tabIndex: -1,
            className: 'wspurge-dialog',
            'data-size': small === true ? 'small' : 'large',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': labelledBy,
            'data-shortcut-modal': 'true',
          },
          h(
            'div',
            { className: 'wspurge-head' },
            h(
              'div',
              { className: 'wspurge-head-text' },
              h('h2', { className: 'wspurge-title', id: labelledBy }, title),
              description !== undefined && description !== null ? h('p', { className: 'wspurge-desc', id: `${labelledBy}-desc` }, description) : null,
            ),
            closable === false
              ? null
              : h('button', { type: 'button', className: 'wspurge-close', onClick: onClose, 'aria-label': '✕', title: '✕' }, '✕'),
          ),
          h('div', { className: 'wspurge-body' }, children),
          footer !== undefined ? h('div', { className: 'wspurge-foot' }, footer) : null,
        ),
      )
    }

    function Confirmation({ t, locale, plan, folderNames, onCancel, onConfirm, busy, error }) {
      const folderEntries = useMemo(() => (plan.workspaces ?? []).filter((workspace) => workspace.deleteFolder === true), [plan])
      const [typed, setTyped] = useState(() => {
        const initial = {}
        for (const workspace of folderEntries) initial[workspace.id] = folderNames?.[workspace.id] ?? ''
        return initial
      })
      const ready = folderEntries.every((workspace) => (typed[workspace.id] ?? '').trim().toLowerCase() === baseName(workspace.path).toLowerCase())
      return h(Dialog, {
        small: true,
        labelledBy: 'wspurge-confirm-title',
        title: t('panel.confirmTitle'),
        onClose: busy === true ? () => {} : onCancel,
        footer: h(
          React.Fragment,
          null,
          h('span', { className: 'wspurge-foot-note' }, t('panel.recycleNote')),
          h('button', { type: 'button', className: 'wspurge-btn', onClick: onCancel, disabled: busy === true }, t('panel.cancel')),
          h(
            'button',
            {
              type: 'button',
              className: 'wspurge-btn',
              'data-variant': 'danger',
              onClick: onConfirm,
              disabled: busy === true || !ready,
              'data-autofocus': 'true',
            },
            busy === true ? h(Spinner) : h(IconTrash),
            h('span', null, busy === true ? t('panel.working') : t('panel.confirm')),
          ),
        ),
      }, [
        error !== undefined ? h('div', { className: 'wspurge-warn', role: 'alert' }, error) : null,
        h('p', { className: 'wspurge-desc', style: { margin: '0 0 8px' } }, t('panel.confirmBody')),
        h('div', { className: 'wspurge-row-meta' }, t('panel.confirmSessions', { count: (plan.sessions ?? []).length })),
        (plan.workspaces ?? []).length > 0
          ? h('div', { className: 'wspurge-row-meta' }, t('panel.confirmWorkspaces', { count: plan.workspaces.length }))
          : null,
        folderEntries.length > 0
          ? h(
              'div',
              { className: 'wspurge-fold', style: { marginLeft: 0 } },
              h('div', { style: { fontWeight: 600 } }, t('panel.confirmFolders')),
              folderEntries.map((workspace) => {
                const expected = baseName(workspace.path)
                const matches = (typed[workspace.id] ?? '').trim().toLowerCase() === expected.toLowerCase()
                return h(
                  'div',
                  { key: workspace.id, style: { marginTop: 8 } },
                  h('div', { className: 'wspurge-path', title: workspace.path, style: { whiteSpace: 'normal', overflowWrap: 'anywhere' } }, workspace.path),
                  h('div', { className: 'wspurge-row-meta' }, t('panel.typeFolderHint', { name: expected })),
                  h('input', {
                    type: 'text',
                    className: 'wspurge-input',
                    value: typed[workspace.id] ?? '',
                    placeholder: expected,
                    'aria-label': t('panel.typeFolderHint', { name: expected }),
                    'aria-invalid': matches ? 'false' : 'true',
                    onChange: (event) => setTyped((current) => ({ ...current, [workspace.id]: event.target.value })),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' && ready && busy !== true) onConfirm()
                    },
                  }),
                )
              }),
            )
          : null,
        locale === undefined ? null : null,
      ])
    }

    function Row({ t, locale, name, meta, checked, onToggle, locked, live, onDelete, deleting, deleteLabel }) {
      return h(
        'div',
        { className: 'wspurge-row', 'data-kind': 'session' },
        h('input', {
          type: 'checkbox',
          className: 'wspurge-check',
          checked: checked === true,
          disabled: locked === true,
          onChange: (event) => onToggle(event.currentTarget.checked),
          'aria-label': name,
        }),
        h(
          'div',
          { className: 'wspurge-row-main' },
          h(
            'div',
            { className: 'wspurge-row-title' },
            h('span', { className: 'wspurge-row-name', title: name }, name),
            locked === true ? h('span', { className: 'wspurge-tag' }, t('panel.current')) : null,
            live === true ? h('span', { className: 'wspurge-tag', 'data-kind': 'live' }, t('panel.liveWarning')) : null,
          ),
          meta !== undefined && meta.length > 0 ? h('div', { className: 'wspurge-row-meta' }, meta.filter(Boolean).join(' · ')) : null,
        ),
        onDelete !== undefined
          ? h(
              'button',
              {
                type: 'button',
                className: 'wspurge-btn',
                'data-variant': 'link',
                disabled: locked === true || deleting === true,
                onClick: onDelete,
                title: deleteLabel ?? t('panel.deleteSession'),
              },
              deleting === true ? h(Spinner) : h(IconTrash),
              h('span', null, deleteLabel ?? t('panel.deleteSession')),
            )
          : null,
      )
    }

    function WorkspaceGroup({ t, locale, workspace, selection, onToggle, onDeleteWorkspace, onDeleteSession, busy, selfSessionId, deletingSession }) {
      const [askFolder, setAskFolder] = useState(false)
      const [folderName, setFolderName] = useState('')
      const expected = baseName(workspace.path)
      const folderReady = askFolder && folderName.trim().toLowerCase() === expected.toLowerCase()
      const sessions = workspace.sessions ?? []
      return h(
        'section',
        { className: 'wspurge-group' },
        h(
          'div',
          { className: 'wspurge-group-title' },
          h('span', null, workspace.title ?? workspace.id),
          h('span', { className: 'wspurge-path', title: workspace.path }, workspace.path),
        ),
        sessions.length === 0
          ? h('div', { className: 'wspurge-note' }, t('panel.noSessions'))
          : sessions.map((session) =>
              h(Row, {
                key: session.id,
                t,
                locale,
                name: session.title ?? t('panel.untitled'),
                meta: [formatTime(session.createdAt, locale), session.cwd],
                checked: selection.sessionIds.includes(session.id),
                locked: session.id === selfSessionId,
                live: session.live === true,
                onToggle: (value) => onToggle('session', session.id, value),
                onDelete: () => onDeleteSession(session.id),
                deleting: deletingSession === session.id,
              }),
            ),
        h(
          'div',
          { className: 'wspurge-row', 'data-kind': 'workspace' },
          h('input', {
            type: 'checkbox',
            className: 'wspurge-check',
            checked: selection.workspaceIds.includes(workspace.id),
            disabled: busy === true,
            onChange: (event) => onToggle('workspace', workspace.id, event.currentTarget.checked),
            'aria-label': `${t('panel.deleteWorkspace')}: ${workspace.title ?? workspace.id}`,
          }),
          h(
            'div',
            { className: 'wspurge-row-main' },
            h('div', { className: 'wspurge-row-title' }, h('span', { className: 'wspurge-row-name' }, `${t('panel.deleteWorkspace')} · ${workspace.title ?? workspace.id}`)),
            h('div', { className: 'wspurge-row-meta' }, workspace.folderExists === true ? workspace.path : t('panel.folderUnavailable')),
          ),
          h(
            'button',
            { type: 'button', className: 'wspurge-btn', 'data-variant': 'link', disabled: busy === true, onClick: () => onDeleteWorkspace(workspace, false) },
            h(IconTrash),
            h('span', null, t('panel.deleteWorkspace')),
          ),
        ),
        workspace.folderExists === true
          ? h(
              'div',
              { className: 'wspurge-fold' },
              h(
                'label',
                null,
                h('input', {
                  type: 'checkbox',
                  className: 'wspurge-check',
                  checked: askFolder,
                  disabled: busy === true,
                  onChange: (event) => setAskFolder(event.currentTarget.checked),
                }),
                h('span', null, t('panel.folderOption')),
              ),
              askFolder
                ? h(
                    'div',
                    { style: { marginTop: 6 } },
                    h('input', {
                      type: 'text',
                      className: 'wspurge-input',
                      value: folderName,
                      placeholder: expected,
                      'aria-label': t('panel.typeFolderHint', { name: expected }),
                      onChange: (event) => setFolderName(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter' && folderReady && busy !== true) onDeleteWorkspace(workspace, true)
                      },
                    }),
                    h('div', { className: 'wspurge-row-meta' }, t('panel.typeFolderHint', { name: expected })),
                    h(
                      'div',
                      { style: { marginTop: 6 } },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'wspurge-btn',
                          'data-variant': 'danger',
                          disabled: !folderReady || busy === true,
                          onClick: () => onDeleteWorkspace(workspace, true),
                        },
                        h(IconTrash),
                        h('span', null, `${t('panel.deleteWorkspace')} + ${expected}`),
                      ),
                    ),
                  )
                : null,
            )
          : null,
      )
    }

    function Panel({ t, locale, ctx, selfSessionId, onClose, notify }) {
      const [data, setData] = useState(undefined)
      const [error, setError] = useState(undefined)
      const [loading, setLoading] = useState(true)
      const [selection, setSelection] = useState({ sessionIds: [], workspaceIds: [] })
      const [plan, setPlan] = useState(undefined)
      const [folderNames, setFolderNames] = useState({})
      const [busy, setBusy] = useState(false)
      const [confirmError, setConfirmError] = useState(undefined)
      const [deletingSession, setDeletingSession] = useState(undefined)
      const aliveRef = useRef(true)

      useEffect(() => {
        aliveRef.current = true
        return () => {
          aliveRef.current = false
        }
      }, [])

      const load = useCallback(
        async (signal) => {
          setLoading(true)
          try {
            const snapshot = await rpc(ctx, 'list', {}, signal)
            if (!aliveRef.current) return
            setData(snapshot)
            setError(undefined)
          } catch (failure) {
            if (signal?.aborted === true || !aliveRef.current) return
            setError(failure?.message ?? String(failure))
          } finally {
            if (aliveRef.current) setLoading(false)
          }
        },
        [ctx],
      )

      useEffect(() => {
        const controller = new AbortController()
        load(controller.signal)
        return () => controller.abort()
      }, [load])

      const toggle = useCallback((kind, id, value) => {
        setSelection((current) => {
          const list = kind === 'session' ? [...current.sessionIds] : [...current.workspaceIds]
          const index = list.indexOf(id)
          if (value && index < 0) list.push(id)
          if (!value && index >= 0) list.splice(index, 1)
          return kind === 'session' ? { ...current, sessionIds: list } : { ...current, workspaceIds: list }
        })
      }, [])

      const selectAll = useCallback(() => {
        const sessions = []
        for (const workspace of data?.workspaces ?? []) {
          for (const session of workspace.sessions ?? []) if (session.id !== selfSessionId) sessions.push(session.id)
        }
        for (const archived of data?.archived ?? []) if (archived.id !== selfSessionId) sessions.push(archived.id)
        for (const orphan of data?.orphans ?? []) if (orphan.id !== selfSessionId) sessions.push(orphan.id)
        setSelection({ sessionIds: [...new Set(sessions)], workspaceIds: (data?.workspaces ?? []).map((workspace) => workspace.id) })
      }, [data, selfSessionId])

      const clear = useCallback(() => setSelection({ sessionIds: [], workspaceIds: [] }), [])

      const deleteSessions = useCallback(
        async (sessionIds, doneMessage) => {
          const result = await rpc(ctx, 'deleteSessions', { sessionIds, selfSessionId })
          const reports = result?.reports ?? []
          const removed = reports.filter((report) => report.removed === true).length
          const failures = result?.failures ?? []
          if (doneMessage !== undefined) notify(doneMessage(removed), failures.length === 0 ? 'ok' : 'error')
          if (failures.length > 0) notify(`${t('panel.partial')}\n${failures.join('\n')}`, 'error')
          return removed
        },
        [ctx, selfSessionId, notify, t],
      )

      const deleteOne = useCallback(
        async (sessionId) => {
          if (sessionId === selfSessionId) return
          setDeletingSession(sessionId)
          try {
            const removed = await deleteSessions([sessionId], (count) => t('panel.done', { sessions: count, workspaces: 0 }))
            if (removed > 0) {
              try {
                ctx.sessions?.refreshProjections?.(sessionId)?.catch?.(() => {})
              } catch {
                /* ignore */
              }
            }
            await load()
          } catch (failure) {
            notify(failure?.message ?? String(failure), 'error')
          } finally {
            if (aliveRef.current) setDeletingSession(undefined)
          }
        },
        [ctx, selfSessionId, deleteSessions, notify, t, load],
      )

      const requestOneWorkspace = useCallback(
        (workspace, withFolder) => {
          setConfirmError(undefined)
          setFolderNames((current) => ({ ...current, [workspace.id]: withFolder === true ? '' : current[workspace.id] ?? '' }))
          setPlan({
            sessions: [],
            workspaces: [{ id: workspace.id, title: workspace.title ?? workspace.id, path: workspace.path, deleteFolder: withFolder === true }],
          })
        },
        [],
      )

      const run = useCallback(async () => {
        if (plan === undefined) return
        setBusy(true)
        setConfirmError(undefined)
        try {
          let sessions = 0
          let workspaces = 0
          const failures = []
          if ((plan.sessions ?? []).length > 0) {
            const result = await rpc(ctx, 'deleteSessions', { sessionIds: plan.sessions, selfSessionId })
            sessions += (result?.reports ?? []).filter((report) => report.removed === true).length
            failures.push(...(result?.failures ?? []))
          }
          if ((plan.workspaces ?? []).length > 0) {
            const deleteFolders = plan.workspaces.some((workspace) => workspace.deleteFolder === true)
            const folderConfirms = {}
            for (const workspace of plan.workspaces) {
              if (workspace.deleteFolder !== true) continue
              folderConfirms[workspace.id] = folderNames[workspace.id] ?? ''
            }
            const result = await rpc(ctx, 'deleteWorkspaces', {
              workspaceIds: plan.workspaces.map((workspace) => workspace.id),
              deleteFolders,
              folderConfirms,
              selfSessionId,
            })
            for (const report of result?.reports ?? []) {
              if (report.removed === true) workspaces += 1
              sessions += (report.sessions ?? []).filter((session) => session.removed === true).length
            }
            failures.push(...(result?.failures ?? []))
          }
          if (aliveRef.current) {
            setPlan(undefined)
            clear()
          }
          notify(
            failures.length === 0 ? t('panel.done', { sessions, workspaces }) : `${t('panel.partial')}\n${failures.join('\n')}`,
            failures.length === 0 ? 'ok' : 'error',
          )
          await load()
        } catch (failure) {
          if (aliveRef.current) setConfirmError(failure?.message ?? String(failure))
        } finally {
          if (aliveRef.current) setBusy(false)
        }
      }, [plan, folderNames, ctx, selfSessionId, clear, notify, t, load])

      const selectedCount = selection.sessionIds.length + selection.workspaceIds.length

      const body =
        data === undefined && loading
          ? h('div', { className: 'wspurge-empty' }, h(Spinner), h('span', null, t('panel.loading')))
          : error !== undefined
            ? h('div', { className: 'wspurge-warn', role: 'alert' }, `${t('panel.errorTitle')}: ${error}`)
            : h(
                React.Fragment,
                null,
                data?.supportsRecycleBin !== true ? h('div', { className: 'wspurge-warn' }, t('panel.folderUnavailable')) : null,
                (data?.workspaces ?? []).length === 0 && (data?.archived ?? []).length === 0 && (data?.orphans ?? []).length === 0
                  ? h('div', { className: 'wspurge-empty' }, t('panel.empty'))
                  : null,
                (data?.workspaces ?? []).map((workspace) =>
                  h(WorkspaceGroup, {
                    key: workspace.id,
                    t,
                    locale,
                    workspace,
                    selection,
                    onToggle: toggle,
                    onDeleteWorkspace: requestOneWorkspace,
                    onDeleteSession: deleteOne,
                    busy,
                    selfSessionId,
                    deletingSession,
                  }),
                ),
                (data?.archived ?? []).length > 0
                  ? h(
                      'section',
                      { className: 'wspurge-group' },
                      h('div', { className: 'wspurge-group-title' }, t('panel.archived')),
                      data.archived.map((session) =>
                        h(Row, {
                          key: session.id,
                          t,
                          locale,
                          name: session.title ?? t('panel.untitled'),
                          meta: [formatTime(session.createdAt, locale), session.cwd ?? session.id],
                          checked: selection.sessionIds.includes(session.id),
                          locked: session.id === selfSessionId,
                          live: session.live === true,
                          onToggle: (value) => toggle('session', session.id, value),
                          onDelete: () => deleteOne(session.id),
                          deleting: deletingSession === session.id,
                        }),
                      ),
                    )
                  : null,
                (data?.orphans ?? []).length > 0
                  ? h(
                      'section',
                      { className: 'wspurge-group' },
                      h('div', { className: 'wspurge-group-title' }, t('panel.orphans')),
                      data.orphans.map((session) =>
                        h(Row, {
                          key: session.id,
                          t,
                          locale,
                          name: session.title ?? t('panel.untitled'),
                          meta: [formatTime(session.createdAt, locale), session.cwd ?? session.id],
                          checked: selection.sessionIds.includes(session.id),
                          locked: session.id === selfSessionId,
                          live: session.live === true,
                          onToggle: (value) => toggle('session', session.id, value),
                          onDelete: () => deleteOne(session.id),
                          deleting: deletingSession === session.id,
                        }),
                      ),
                    )
                  : null,
              )

      return h(
        React.Fragment,
        null,
        h(Dialog, {
          labelledBy: 'wspurge-panel-title',
          title: t('panel.title'),
          description: t('panel.description'),
          onClose: busy === true ? () => {} : onClose,
          footer: h(
            React.Fragment,
            null,
            h(
              'div',
              { className: 'wspurge-foot-note' },
              h('button', { type: 'button', className: 'wspurge-btn', 'data-variant': 'link', onClick: selectAll, disabled: loading || busy === true }, t('panel.selectAll')),
              h('button', { type: 'button', className: 'wspurge-btn', 'data-variant': 'link', onClick: clear, disabled: selectedCount === 0 || busy === true }, t('panel.clear')),
              h('button', { type: 'button', className: 'wspurge-btn', 'data-variant': 'link', onClick: () => load(), disabled: loading || busy === true }, t('panel.refresh')),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'wspurge-btn',
                'data-variant': 'danger',
                disabled: selectedCount === 0 || busy === true,
                onClick: () => {
                  setConfirmError(undefined)
                  const workspaces = (data?.workspaces ?? [])
                    .filter((workspace) => selection.workspaceIds.includes(workspace.id))
                    .map((workspace) => ({ id: workspace.id, title: workspace.title ?? workspace.id, path: workspace.path, deleteFolder: false }))
                  setPlan({ sessions: [...selection.sessionIds], workspaces })
                },
              },
              h(IconTrash),
              h('span', null, t('panel.deleteSelected', { count: selectedCount })),
            ),
          ),
        }, body),
        plan !== undefined
          ? h(Confirmation, {
              t,
              locale,
              plan,
              folderNames,
              onCancel: () => {
                if (busy !== true) setPlan(undefined)
              },
              onConfirm: run,
              busy,
              error: confirmError,
            })
          : null,
      )
    }

    function FooterAction({ t, locale, ctx, wide }) {
      const [open, setOpen] = useState(false)
      const [notice, setNotice] = useState(undefined)
      const timerRef = useRef(undefined)
      const notify = useCallback((message, kind) => {
        setNotice({ message, kind: kind ?? 'ok' })
        if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
        timerRef.current = window.setTimeout(() => {
          timerRef.current = undefined
          setNotice(undefined)
        }, 6000)
      }, [])
      useEffect(
        () => () => {
          if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
        },
        [],
      )
      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            type: 'button',
            className: 'wspurge-trigger',
            'data-wide': wide === false ? 'false' : 'true',
            title: t('action.tooltip'),
            'aria-label': t('action.label'),
            'aria-haspopup': 'dialog',
            onClick: () => setOpen(true),
          },
          h(IconTrash),
          wide === false ? null : h('span', { className: 'wspurge-trigger-label' }, t('action.label')),
        ),
        open ? h(Panel, { t, locale, ctx, selfSessionId: currentSessionId(ctx), onClose: () => setOpen(false), notify }) : null,
        notice === undefined ? null : h('div', { className: 'wspurge-toast', 'data-kind': notice.kind, role: 'status', 'aria-live': 'polite' }, notice.message),
      )
    }

    /** One row of a session's "..." menu: delete this conversation permanently. */
    function MenuItem({ t, ctx, sessionId, useMenuOpenState }) {
      const [busy, setBusy] = useState(false)
      const state = typeof useMenuOpenState === 'function' ? useMenuOpenState() : undefined
      const setMenuOpen = Array.isArray(state) ? state[1] : undefined
      const locked = sessionId === currentSessionId(ctx)
      const onClick = useCallback(
        async (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (typeof setMenuOpen === 'function') setMenuOpen(false)
          if (locked) {
            window.alert(t('panel.errorTitle') + ': ' + t('panel.current'))
            return
          }
          if (!window.confirm(t('panel.confirmTitle') + '\n' + t('panel.confirmBody') + '\n' + t('panel.confirmSessions', { count: 1 }))) return
          setBusy(true)
          try {
            const result = await rpc(ctx, 'deleteSessions', { sessionIds: [sessionId] })
            const failures = result?.failures ?? []
            if (failures.length === 0) {
              try {
                ctx.sessions?.refreshProjections?.(sessionId)?.catch?.(() => {})
              } catch {
                /* ignore */
              }
            } else {
              window.alert(`${t('panel.partial')}\n${failures.join('\n')}`)
            }
          } catch (failure) {
            window.alert(`${t('panel.errorTitle')}: ${failure?.message ?? String(failure)}`)
          } finally {
            setBusy(false)
          }
        },
        [ctx, sessionId, setMenuOpen, locked, t],
      )
      const onMouseOver = useCallback((event) => {
        event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover-danger, var(--dsw-alias-interactive-bg-hover))'
      }, [])
      const onMouseOut = useCallback((event) => {
        event.currentTarget.style.background = 'transparent'
      }, [])
      const style = {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '6px 10px',
        border: 0,
        borderRadius: 'var(--dsw-radius-md, 8px)',
        background: 'transparent',
        color: locked ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-state-error-primary)',
        font: 'inherit',
        fontSize: 12,
        lineHeight: '18px',
        textAlign: 'left',
        cursor: 'pointer',
      }
      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          style,
          'aria-disabled': locked ? 'true' : 'false',
          onMouseOver: locked ? undefined : onMouseOver,
          onMouseOut: locked ? undefined : onMouseOut,
          onClick,
        },
        busy ? h(Spinner) : h(IconTrash),
        h('span', null, t('panel.deleteSession')),
      )
    }

    return {
      name: 'workspace-purge-ui',
      inject: ['slots', 'locale', 'connection', 'sessions'],
      apply(ctx) {
        ctx.effect(() => {
          if (document.getElementById(STYLE_ID) !== null) return () => {}
          const element = document.createElement('style')
          element.id = STYLE_ID
          element.textContent = CSS
          document.head.appendChild(element)
          return () => element.remove()
        })

        ctx.effect(() => ctx.locale.register(NS, { en: flattenDictionary(LOCALE_EN), zh: flattenDictionary(LOCALE_ZH) }))
        const bound = ctx.locale.bind(NS)
        const translate = (props) => props?.t ?? bound

        /**
         * Translate through the slot-owned translator when available, otherwise the
         * package-bound one; the locale argument only drives date formatting.
         */
        const renderFooter = (props) =>
          h(FooterAction, { t: translate(props), locale: props?.locale ?? activeLocale(ctx), ctx, wide: props?.wide === true })

        ctx.slots.inject('sidebar.footer.action', function* () {
          yield ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'workspace-purge.manage', order: 600, locale: NS },
            renderFooter,
          )
        })

        ctx.slots.inject('sidebar.workspaces.session.menu.item', function* () {
          yield ctx.slots.register(
            { name: 'sidebar.workspaces.session.menu.item', id: 'workspace-purge.menu-item', order: 500, locale: NS },
            (props) =>
              h(MenuItem, {
                t: translate(props),
                ctx,
                sessionId: props?.sessionId,
                useMenuOpenState: props?.useMenuOpenState,
              }),
          )
        })
      },
    }

    /**
     * The locale service resolves a key with a flat `dictionary[key]` lookup, so nested
     * dictionaries must be flattened to dotted keys before they are registered.
     */
    function flattenDictionary(source, prefix, output) {
      const target = output ?? {}
      for (const [key, value] of Object.entries(source ?? {})) {
        const path = prefix === undefined || prefix === '' ? key : `${prefix}.${key}`
        if (value !== null && typeof value === 'object' && Array.isArray(value) === false) {
          flattenDictionary(value, path, target)
        } else {
          target[path] = value
        }
      }
      return target
    }

    function activeLocale(ctx) {
      try {
        return ctx.get('locale')?.getSnapshot?.()?.active ?? 'zh'
      } catch {
        return 'zh'
      }
    }
  },
})