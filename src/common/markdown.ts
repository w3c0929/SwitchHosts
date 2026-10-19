/**
 * Markdown 条目识别。
 *
 * 规则：条目标题（去除首尾空白、不区分大小写）以 `.md` 结尾即视为
 * Markdown 文档条目，本地/远程方案一致。
 *
 * 为什么不做内容自动识别：hosts 文件的注释行 `# 注释` 与 Markdown
 * 一级标题语法完全相同，按内容猜测会把大量纯注释的 hosts 文件误判
 * 为 Markdown，且内容变化会让模式来回跳变。因此只认显式后缀。
 */
export const isMarkdownTitle = (title?: string | null): boolean =>
  !!title && title.trim().toLowerCase().endsWith('.md')

export const isMarkdownEntry = (entry?: { title?: string } | null): boolean =>
  isMarkdownTitle(entry?.title)
