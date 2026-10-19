import { actions, agent } from '@renderer/core/agent'
import events from '@common/events'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import styles from './MarkdownPreview.module.scss'

interface Props {
  content: string
}

/**
 * Markdown 预览：渲染 GFM（表格/任务列表/删除线）+ 代码块语法高亮。
 * react-markdown 默认不执行原始 HTML（无 XSS 风险）；链接点击交给
 * 系统浏览器打开，不在 WebView 内部导航。
 */
const MarkdownPreview = ({ content }: Props) => {
  return (
    <div className={styles.root} data-testid="markdown-preview">
      <div className={styles.body}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeHighlight, { detect: false }]]}
          components={{
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
