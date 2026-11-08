import { actions, agent } from '@renderer/core/agent'
import events from '@common/events'
import useI18n from '@renderer/models/useI18n'
import { IconCheck, IconCopy } from '@tabler/icons-react'
import React, { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import styles from './MarkdownPreview.module.scss'

interface Props {
  content: string
  /** 滚动容器 ref（预编模式用于同步滚动）。 */
  scrollRef?: React.Ref<HTMLDivElement>
  onScroll?: React.UIEventHandler<HTMLDivElement>
}

/** 代码块：头部栏（语言 + 复制按钮）+ 高亮代码。 */
const CodeBlock = ({ children }: { children?: React.ReactNode }) => {
  const { lang } = useI18n()
  const refPre = useRef<HTMLPreElement>(null)
  const refTimer = useRef<number | null>(null)
  const [copied, setCopied] = useState(false)

  const child = React.Children.toArray(children)[0]
  const className =
    React.isValidElement(child) &&
    typeof (child.props as { className?: unknown }).className === 'string'
      ? ((child.props as { className?: string }).className as string)
      : ''
  const language = /language-([\w-]+)/.exec(className)?.[1] || ''

  useEffect(
    () => () => {
      if (refTimer.current) window.clearTimeout(refTimer.current)
    },
    [],
  )

  const onCopy = async () => {
    const text = refPre.current?.textContent ?? ''
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // 回退：部分 WebView 环境没有/拒绝 Clipboard API。
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } finally {
        ta.remove()
      }
    }
    setCopied(true)
    if (refTimer.current) window.clearTimeout(refTimer.current)
    refTimer.current = window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className={styles.code_block} data-testid="code-block">
      <div className={styles.code_header}>
        <span className={styles.code_lang}>{language || 'text'}</span>
        <button
          type="button"
          className={styles.copy_btn}
          onClick={onCopy}
          data-testid="code-copy-button"
        >
          {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          <span>{copied ? lang.copied : lang.copy}</span>
        </button>
      </div>
      <pre ref={refPre}>{children}</pre>
    </div>
  )
}

/**
 * Markdown 预览：渲染 GFM（表格/任务列表/删除线）+ 代码块语法高亮，
 * 代码块带一键复制。react-markdown 默认不执行原始 HTML（无 XSS 风险）；
 * 链接点击交给系统浏览器打开，不在 WebView 内部导航。
 */
const MarkdownPreview = ({ content, scrollRef, onScroll }: Props) => {
  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className={styles.root}
      data-testid="markdown-preview"
    >
      <div className={styles.body}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeHighlight, { detect: false }]]}
          components={{
            pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
            a: ({ href, children }) => (
              <a
                href={href}
                onClick={(e) => {
                  e.preventDefault()
                  if (!href) return
                  agent.broadcast(events.browser_link, href)
                  actions.openUrl(href).catch((err) => console.error(err))
                }}
              >
                {children}
              </a>
            ),
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  )
}

export default MarkdownPreview
