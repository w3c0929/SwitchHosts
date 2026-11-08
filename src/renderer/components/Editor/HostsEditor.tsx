/**
 * @author: oldj
 * @homepage: https://oldj.net
 */

import { IHostsListObject } from '@common/data'
import events from '@common/events'
import { isMarkdownEntry } from '@common/markdown'
import { normalizeLineEndings } from '@common/newlines'
import { IFindShowSourceParam } from '@common/types'
import StatusBar from '@renderer/components/StatusBar'
import { actions, agent } from '@renderer/core/agent'
import { showErrorNotification } from '@renderer/core/notify'
import useOnBroadcast from '@renderer/core/useOnBroadcast'
import useConfigs from '@renderer/models/useConfigs'
import useHostsData from '@renderer/models/useHostsData'
import useI18n from '@renderer/models/useI18n'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useDebounceFn } from 'ahooks'
import clsx from 'clsx'
import { useDeferredValue, useEffect, useRef, useState } from 'react'
import {
  buildExtensions,
  type BuiltExtensions,
  readOnlyExtensions,
} from './hosts_cm'
import { toggleCommentByLine, toggleCommentBySelection } from './hosts_highlight'
import styles from './HostsEditor.module.scss'
import MarkdownPreview from './MarkdownPreview'

const HostsEditor = () => {
  const { currentHosts, isReadOnly } = useHostsData()
  const { configs } = useConfigs()
  const { lang } = useI18n()
  const hostsId = currentHosts?.id || '0'
  const readOnly = isReadOnly(currentHosts)
  // 控制右侧编辑器是否显示内容（默认开；用户可在编辑表单中关闭）
  const showContent = currentHosts?.show_content !== false
  // 标题以 .md 结尾或关联了本地 md 文件 = Markdown 条目：
  // 默认显示预览，可切换到编辑视图。
  const isMd = isMarkdownEntry(currentHosts)
  // 关联本地文件时，内容直接读写该文件（源文件为准）。
  const mdPath = (currentHosts?.md_path || '').trim()
  const mdViewMode =
    configs?.md_view_mode === 'source'
      ? 'source'
      : configs?.md_view_mode === 'preview-edit'
        ? 'preview-edit'
        : 'preview'
  const showMdPreview = isMd && mdViewMode === 'preview'
  // 预编：源码编辑 + 实时预览分屏，可拖动分隔条。
  // 布局由偏好决定：默认左预览 / 右编辑；开启「编辑区在左侧」后反转。
  const showMdSplit = isMd && mdViewMode === 'preview-edit'
  const splitEditLeft = configs?.md_split_edit_left === true
  const splitSyncScroll = configs?.md_split_sync_scroll !== false
  const [content, setContent] = useState('')
  // 预编分屏时预览随输入实时刷新；大文档用延迟值避免逐键渲染卡顿。
  const previewContent = useDeferredValue(content)
  const [mdLoadError, setMdLoadError] = useState<string | null>(null)
  const [splitRatio, setSplitRatio] = useState(0.5)
  const [verticalSplit, setVerticalSplit] = useState(false)
  const refSplit = useRef<HTMLDivElement>(null)
  const refPreviewScroll = useRef<HTMLDivElement | null>(null)

  const refMount = useRef<HTMLDivElement>(null)
  const refView = useRef<EditorView | null>(null)
  const refBuilt = useRef<BuiltExtensions | null>(null)
  const refMeasureFrame = useRef<number | null>(null)
  // 同步滚动状态：镜像配置供稳定的事件回调读取；lock 防止两侧互相触发。
  const refSplitActive = useRef(false)
  const refSyncScroll = useRef(true)
  const refScrollLock = useRef<'editor' | 'preview' | null>(null)
  const refScrollReleaseTimer = useRef<number | null>(null)
  // Refs mirror React state so that callbacks captured by EditorView extensions
  // (which are created once on mount) can always read the latest values.
  const refHostsId = useRef(hostsId)
  const refReadOnly = useRef(readOnly)
  const refShowContent = useRef(showContent)
  const refIsMd = useRef(isMd)
  const refMdPath = useRef(mdPath)
  // 本地 md 文件原始换行风格：保存时还原，避免把 CRLF 文件改成 LF。
  const refMdEol = useRef<'lf' | 'crlf'>('lf')
  // Pending find: when a show_source event arrives before the target hosts is loaded
  // (List broadcasts select_hosts then show_source synchronously, but hostsId only
  // updates on the next render), we stash the params here and apply them once
  // loadContent finishes (with a 3s timeout to avoid stale state).
  const refPendingFind = useRef<IFindShowSourceParam | null>(null)
  const refPendingFindTimer = useRef<number | null>(null)

  const clearPendingFind = () => {
    if (refPendingFindTimer.current) {
      window.clearTimeout(refPendingFindTimer.current)
      refPendingFindTimer.current = null
    }
    refPendingFind.current = null
  }

  useEffect(
    () => () => {
      clearPendingFind()
      if (refMeasureFrame.current !== null) {
        window.cancelAnimationFrame(refMeasureFrame.current)
        refMeasureFrame.current = null
      }
      if (refScrollReleaseTimer.current !== null) {
        window.clearTimeout(refScrollReleaseTimer.current)
        refScrollReleaseTimer.current = null
      }
    },
    [],
  )

  useEffect(() => {
    refHostsId.current = hostsId
  }, [hostsId])

  useEffect(() => {
    refReadOnly.current = readOnly
  }, [readOnly])

  useEffect(() => {
    refShowContent.current = showContent
  }, [showContent])

  useEffect(() => {
    refIsMd.current = isMd
  }, [isMd])

  useEffect(() => {
    refMdPath.current = mdPath
  }, [mdPath])

  useEffect(() => {
    refSplitActive.current = showMdSplit
    refSyncScroll.current = splitSyncScroll
  }, [showMdSplit, splitSyncScroll])

  /** 释放同步锁（防止两侧滚动事件互相触发形成回环）。 */
  const releaseScrollLock = () => {
    if (refScrollReleaseTimer.current) {
      window.clearTimeout(refScrollReleaseTimer.current)
    }
    refScrollReleaseTimer.current = window.setTimeout(() => {
      refScrollLock.current = null
      refScrollReleaseTimer.current = null
    }, 120)
  }

  /** 编辑区滚动 → 预览区按比例同步。 */
  const onEditorScroll = () => {
    if (!refSplitActive.current || !refSyncScroll.current) return
    if (refScrollLock.current === 'preview') return
    const view = refView.current
    const target = refPreviewScroll.current
    if (!view || !target) return
    refScrollLock.current = 'editor'
    const src = view.scrollDOM
    const srcMax = src.scrollHeight - src.clientHeight
    const ratio = srcMax > 0 ? src.scrollTop / srcMax : 0
    const targetMax = target.scrollHeight - target.clientHeight
    target.scrollTop = ratio * Math.max(0, targetMax)
    releaseScrollLock()
  }

  /** 预览区滚动 → 编辑区按比例同步。 */
  const onPreviewScroll = () => {
    if (!refSplitActive.current || !refSyncScroll.current) return
    if (refScrollLock.current === 'editor') return
    const view = refView.current
    const src = refPreviewScroll.current
    if (!view || !src) return
    refScrollLock.current = 'preview'
    const srcMax = src.scrollHeight - src.clientHeight
    const ratio = srcMax > 0 ? src.scrollTop / srcMax : 0
    const editor = view.scrollDOM
    const targetMax = editor.scrollHeight - editor.clientHeight
    editor.scrollTop = ratio * Math.max(0, targetMax)
    releaseScrollLock()
  }

  const { run: toSave } = useDebounceFn(
    (id: string, nextContent: string, mdFilePath: string) => {
      if (mdFilePath) {
        // 关联本地文件：写回原文件（保持原有换行风格），同时同步内部
        // 缓存，供查找/导出等仍以缓存为数据源的路径使用。
        const payload =
          refMdEol.current === 'crlf' ? nextContent.replace(/\n/g, '\r\n') : nextContent
        actions
          .writeMdFile(mdFilePath, payload)
          .catch((e) =>
            showErrorNotification({
              title: lang.md_file_write_failed,
              message: `${mdFilePath}\n${String((e as Error)?.message || e)}`,
            }),
          )
        actions
          .setHostsContent(id, nextContent)
          .then(() => agent.broadcast(events.hosts_content_changed, id))
          .catch((e) => console.error(e))
        return
      }
      actions
        .setHostsContent(id, nextContent)
        .then(() => agent.broadcast(events.hosts_content_changed, id))
        .catch((e) => console.error(e))
    },
    { wait: 1000 },
  )

  const onDocChange = (nextContent: string) => {
    const normalizedContent = normalizeLineEndings(nextContent)
    setContent(normalizedContent)
    // 快照当前路径：切换条目后防抖回调仍写回原文件。
    toSave(refHostsId.current, normalizedContent, refMdPath.current)
  }

  const onGutterClick = (lineIndex: number) => {
    if (refReadOnly.current) return
    const view = refView.current
    if (!view) return
    if (view.composing) return

    const code = view.state.doc.toString()
    const sel = view.state.selection.main
    const next = toggleCommentByLine(code, lineIndex, sel.from, sel.to)
    if (!next.changed) return

    view.dispatch({
      changes: next.changes,
      selection: { anchor: next.selectionStart, head: next.selectionEnd },
    })
    view.focus()
  }

  const toggleComment = () => {
    if (refReadOnly.current) return
    // Markdown 源码没有 hosts 注释语义，跳过。
    if (refIsMd.current) return
    const view = refView.current
    if (!view) return
    // Skip while an IME composition is active to avoid dropping characters.
    if (view.composing) return

    const code = view.state.doc.toString()
    const sel = view.state.selection.main
    const next = toggleCommentBySelection(code, sel.from, sel.to, true)
    if (!next.changed) return

    view.dispatch({
      changes: next.changes,
      selection: { anchor: next.selectionStart, head: next.selectionEnd },
      scrollIntoView: true,
    })
    view.focus()
  }

  /** Restore a character-offset selection in the editor (used by find/show-source). */
  const setSelection = (params: IFindShowSourceParam) => {
    const view = refView.current
    if (!view) return

    const docLen = view.state.doc.length
    const start = Math.max(0, Math.min(params.start, docLen))
    const end = Math.max(0, Math.min(params.end, docLen))
    view.dispatch({
      selection: { anchor: start, head: end },
      effects: EditorView.scrollIntoView(start, { y: 'center' }),
    })
    view.focus()
  }

  /**
   * Build a fresh set of extensions bound to the current readOnly value, then
   * either install them on a new EditorView or apply via setState. We rebuild
   * on every doc swap because setState resets compartments to the value bound
   * at extension-creation time — reusing the mount-time extensions would silently
   * revert any subsequent readOnly reconfigure.
   */
  const rebuildExtensions = () =>
    buildExtensions({
      initialReadOnly: refReadOnly.current,
      onDocChange,
      onGutterClick,
      markdown: refIsMd.current,
    })

  const refreshEditorLayout = (view: EditorView) => {
    view.requestMeasure()
    if (refMeasureFrame.current !== null) {
      window.cancelAnimationFrame(refMeasureFrame.current)
    }
    refMeasureFrame.current = window.requestAnimationFrame(() => {
      refMeasureFrame.current = null
      if (refView.current === view) {
        view.requestMeasure()
      }
    })
  }

  const createEditorView = (doc: string) => {
    const mount = refMount.current
    if (!mount) return null

    refView.current?.destroy()
    mount.replaceChildren()

    const built = rebuildExtensions()
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: built.extensions }),
      parent: mount,
    })

    // 同步滚动：监听编辑区滚动，按比例带动预览区（监听随 view 一并销毁）。
    view.scrollDOM.addEventListener('scroll', onEditorScroll)

    refBuilt.current = built
    refView.current = view
    return view
  }

  /** Fetch hosts content and replace the editor state (clears undo history). */
  const loadContent = async (targetHostsId = hostsId) => {
    // show_content 关闭时，编辑器清空不加载内容
    if (targetHostsId !== '0' && !refShowContent.current) {
      setContent('')
      setMdLoadError(null)
      const view = createEditorView('')
      if (view) refreshEditorLayout(view)
      return
    }

    let rawContent: string
    try {
      if (targetHostsId === '0') {
        rawContent = await actions.getSystemHosts()
      } else if (refMdPath.current) {
        // 关联本地 md：以磁盘文件内容为准（记录原换行风格）。
        rawContent = await actions.readMdFile(refMdPath.current)
        refMdEol.current = rawContent.includes('\r\n') ? 'crlf' : 'lf'
      } else {
        rawContent = await actions.getHostsContent(targetHostsId)
      }
    } catch (e) {
      if (refHostsId.current !== targetHostsId) return
      // 文件缺失/不可读：显示错误态，不再把错误文本当作可编辑内容，
      // 避免误操作覆盖原文件。
      setMdLoadError(String((e as Error)?.message || e))
      setContent('')
      const view = createEditorView('')
      if (view) refreshEditorLayout(view)
      return
    }

    if (refHostsId.current !== targetHostsId) return

    setMdLoadError(null)
    const nextContent = normalizeLineEndings(rawContent)

    setContent(nextContent)
    const view = createEditorView(nextContent)
    if (!view) return

    const pendingFind = refPendingFind.current
    if (pendingFind && pendingFind.item_id === targetHostsId) {
      setSelection(pendingFind)
      clearPendingFind()
    } else {
      view.contentDOM.blur()
    }
    refreshEditorLayout(view)
  }

  // Mount an empty EditorView first; hosts switches replace the view entirely to
  // avoid stale native caret artifacts in WebKit after document swaps.
  useEffect(() => {
    createEditorView('')

    return () => {
      refView.current?.destroy()
      refView.current = null
      refBuilt.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load content when the active hosts changes, show_content toggles, or the
  // entry flips between Markdown / hosts (rebuild extensions for the new mode).
  useEffect(() => {
    loadContent(hostsId).catch((e) => console.error(e))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostsId, showContent, isMd])

  // 从预览/错误态切回编辑时，编辑器此前处于 display:none，需要重新测量布局。
  useEffect(() => {
    if (showMdPreview || mdLoadError) return
    const view = refView.current
    if (view) refreshEditorLayout(view)
  }, [showMdPreview, isMd, mdLoadError])

  // 窄窗口下分屏改为上下布局。
  useEffect(() => {
    const onResize = () => setVerticalSplit(window.innerWidth < 900)
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 拖动分隔条改变比例后重新测量编辑器布局。
  useEffect(() => {
    if (!showMdSplit) return
    const view = refView.current
    if (view) refreshEditorLayout(view)
  }, [splitRatio, verticalSplit, showMdSplit])

  const onSplitDividerDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const container = refSplit.current
    if (!container) return
    const vertical = verticalSplit
    const onMove = (ev: MouseEvent) => {
      const rect = container.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const ratio = vertical
        ? (ev.clientY - rect.top) / rect.height
        : (ev.clientX - rect.left) / rect.width
      setSplitRatio(Math.min(0.8, Math.max(0.2, ratio)))
    }
    const onUp = () => {
      document.body.style.cursor = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    document.body.style.cursor = vertical ? 'row-resize' : 'col-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Reconfigure read-only state via the compartment without rebuilding the editor.
  useEffect(() => {
    const view = refView.current
    const built = refBuilt.current
    if (!view || !built) return

    view.dispatch({
      effects: built.readOnlyCompartment.reconfigure(readOnlyExtensions(readOnly)),
    })
  }, [readOnly])

  useOnBroadcast(
    events.hosts_refreshed,
    (h: IHostsListObject) => {
      if (hostsId !== '0' && h.id !== hostsId) return
      loadContent().catch((e) => console.error(e))
    },
    [hostsId],
  )

  useOnBroadcast(
    events.hosts_refreshed_by_id,
    (id: string) => {
      if (hostsId !== '0' && hostsId !== id) return
      loadContent().catch((e) => console.error(e))
    },
    [hostsId],
  )

  useOnBroadcast(
    events.set_hosts_on_status,
    () => {
      if (hostsId === '0') {
        loadContent().catch((e) => console.error(e))
      }
    },
    [hostsId],
  )

  useOnBroadcast(
    events.system_hosts_updated,
    () => {
      if (hostsId === '0') {
        loadContent().catch((e) => console.error(e))
      }
    },
    [hostsId],
  )

  useOnBroadcast(events.toggle_comment, toggleComment, [hostsId])

  useOnBroadcast(
    events.show_source,
    (params: IFindShowSourceParam) => {
      // Cross-host jump: List broadcasts select_hosts to switch the active hosts,
      // but hostsId only updates on the next render. Stash params and let
      // loadContent apply them after setState.
      if (params.item_id !== hostsId || !refView.current) {
        clearPendingFind()
        refPendingFind.current = params
        refPendingFindTimer.current = window.setTimeout(clearPendingFind, 3000)
        return
      }

      clearPendingFind()
      setSelection(params)
    },
    [hostsId],
  )

  return (
    <div className={styles.root}>
      <div
        ref={refSplit}
        className={clsx(
          styles.editor,
          readOnly && styles.read_only,
          showMdPreview && styles.md_preview,
          showMdSplit && styles.md_split,
          showMdSplit && verticalSplit && styles.vertical,
        )}
      >
        <div
          ref={refMount}
          data-testid="md-split-editor"
          className={clsx(
            styles.mount,
            (showMdPreview || mdLoadError) && styles.hidden,
          )}
          style={
            showMdSplit
              ? { flexBasis: `${splitRatio * 100}%`, order: splitEditLeft ? 0 : 2 }
              : undefined
          }
        />
        {showMdSplit && !mdLoadError ? (
          <>
            <div
              className={styles.split_divider}
              onMouseDown={onSplitDividerDown}
              data-testid="md-split-divider"
              style={{ order: 1 }}
            />
            <div
              className={styles.split_preview}
              data-testid="md-split-preview"
              style={{ order: splitEditLeft ? 2 : 0 }}
            >
              <MarkdownPreview
                content={previewContent}
                scrollRef={refPreviewScroll}
                onScroll={onPreviewScroll}
              />
            </div>
          </>
        ) : null}
        {mdLoadError ? (
          <div className={styles.md_error}>
            <div className={styles.md_error_title}>{lang.md_file_read_failed}</div>
            <div className={styles.md_error_path}>{mdPath}</div>
            <div className={styles.md_error_message}>{mdLoadError}</div>
          </div>
        ) : showMdPreview ? (
          <MarkdownPreview content={previewContent} />
        ) : null}
      </div>

      <StatusBar
        lineCount={content.split('\n').length}
        bytes={content.length}
        readOnly={readOnly}
      />
    </div>
  )
}

export default HostsEditor
