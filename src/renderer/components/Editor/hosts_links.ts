import { RangeSetBuilder, type Extension } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'

interface CommentLink {
  from: number
  to: number
  url: string
}

/** 行内注释（# 之后）里的 http/https 链接；偏移相对行首。 */
export function getCommentLinks(line: string): CommentLink[] {
  const commentStart = line.indexOf('#')
  if (commentStart < 0) return []

  const links: CommentLink[] = []
  const pattern = /\bhttps?:\/\/[^\s<>"'`，。；：！？（）【】「」“”‘’]+/gi
  for (const match of line.slice(commentStart + 1).matchAll(pattern)) {
    let url = match[0]
    // 去掉句末标点与不成对的右括号；路径中的成对括号保留（含 IPv6）。
    const opening: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
    while (url) {
      const last = url.at(-1)!
      if (/[.,;:!?]/.test(last)) {
        url = url.slice(0, -1)
      } else if (opening[last] && url.split(last).length > url.split(opening[last]).length) {
        url = url.slice(0, -1)
      } else {
        break
      }
    }
    // 必须有真实主机段（`https:///path` 这类没有 host 的拒绝）。
    if (!/^https?:\/\/[^/]/i.test(url)) continue
    try {
      if (!new URL(url).hostname) continue
    } catch {
      continue
    }
    const from = commentStart + 1 + match.index
    links.push({ from, to: from + url.length, url })
  }
  return links
}

function buildLinkDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  let lastLine = 0
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos)
      // 长行可能出现在多个可见区间，按行号去重。
      if (line.number > lastLine) {
        for (const link of getCommentLinks(line.text)) {
          builder.add(
            line.from + link.from,
            line.from + link.to,
            Decoration.mark({
              class: 'hl-comment-link',
              attributes: { 'data-url': link.url },
            }),
          )
        }
        lastLine = line.number
      }
      if (line.to >= to) break
      pos = line.to + 1
    }
  }
  return builder.finish()
}

/**
 * 注释内 URL：Ctrl（macOS 为 Cmd）+ 点击用系统浏览器打开。
 * 普通点击不拦截，避免影响光标定位与文本选择。
 */
export function commentLinks(isMac: boolean, onOpenUrl: (url: string) => void): Extension {
  const modifierHeld = (event: MouseEvent | KeyboardEvent): boolean =>
    !event.altKey &&
    !event.shiftKey &&
    (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)

  const clickedUrl = (event: MouseEvent, view: EditorView): string | undefined => {
    if (event.button !== 0 || !modifierHeld(event)) return
    const link = event.target instanceof Element ? event.target.closest('.hl-comment-link') : null
    if (link && view.contentDOM.contains(link)) return link.getAttribute('data-url') ?? undefined
  }

  const links = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      modifierDown = false

      constructor(readonly view: EditorView) {
        this.decorations = buildLinkDecorations(view)
        // 在文档层监听修饰键：鼠标不动也能切换链接的悬停提示。
        view.dom.ownerDocument.defaultView!.addEventListener('keydown', this.onKey, true)
        view.dom.ownerDocument.defaultView!.addEventListener('keyup', this.onKey, true)
        view.dom.ownerDocument.defaultView!.addEventListener('blur', this.onBlur)
      }

      setModifier(down: boolean) {
        if (this.modifierDown === down) return
        this.modifierDown = down
        this.view.update([])
      }

      onKey = (event: KeyboardEvent) => this.setModifier(modifierHeld(event))
      onBlur = () => this.setModifier(false)

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildLinkDecorations(update.view)
        }
      }

      destroy() {
        this.view.dom.ownerDocument.defaultView!.removeEventListener('keydown', this.onKey, true)
        this.view.dom.ownerDocument.defaultView!.removeEventListener('keyup', this.onKey, true)
        this.view.dom.ownerDocument.defaultView!.removeEventListener('blur', this.onBlur)
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
      eventObservers: {
        mousemove(event) {
          this.setModifier(modifierHeld(event))
        },
        mouseenter(event) {
          this.setModifier(modifierHeld(event))
        },
      },
    },
  )

  return [
    links,
    EditorView.editorAttributes.of((view) =>
      view.plugin(links)?.modifierDown ? { class: 'swh-link-modifier' } : null,
    ),
    EditorView.domEventHandlers({
      // 按住修饰键点击时保留选区，不触发 CodeMirror 的多光标行为。
      mousedown: (event, view) => !!clickedUrl(event, view),
      click(event, view) {
        const url = clickedUrl(event, view)
        if (!url) return false
        onOpenUrl(url)
        return true
      },
    }),
    EditorView.baseTheme({
      '.hl-comment-link': {
        textDecoration: 'underline',
        textUnderlineOffset: '3px',
      },
      '&.swh-link-modifier .hl-comment-link:hover': {
        cursor: 'pointer',
        color: 'var(--swh-editor-ip)',
      },
    }),
  ]
}
