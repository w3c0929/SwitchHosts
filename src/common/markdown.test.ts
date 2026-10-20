import { describe, expect, it } from 'vitest'
import { isMarkdownEntry, isMarkdownTitle } from './markdown'

describe('isMarkdownTitle', () => {
  it('detects the .md suffix case-insensitively', () => {
    expect(isMarkdownTitle('readme.md')).toBe(true)
    expect(isMarkdownTitle('README.MD')).toBe(true)
    expect(isMarkdownTitle('notes.Md')).toBe(true)
  })

  it('trims surrounding whitespace before matching', () => {
    expect(isMarkdownTitle('  readme.md  ')).toBe(true)
    expect(isMarkdownTitle('\tguide.md\n')).toBe(true)
  })

  it('rejects non-markdown or empty titles', () => {
    expect(isMarkdownTitle('hosts')).toBe(false)
    expect(isMarkdownTitle('readme.md.hosts')).toBe(false)
    expect(isMarkdownTitle('my-md-file')).toBe(false)
    expect(isMarkdownTitle('')).toBe(false)
    expect(isMarkdownTitle(undefined)).toBe(false)
    expect(isMarkdownTitle(null)).toBe(false)
  })
})

describe('isMarkdownEntry', () => {
  it('reads the title from the entry shape', () => {
    expect(isMarkdownEntry({ title: 'docs.md' })).toBe(true)
    expect(isMarkdownEntry({ title: 'work hosts' })).toBe(false)
    expect(isMarkdownEntry(null)).toBe(false)
    expect(isMarkdownEntry(undefined)).toBe(false)
  })

  it('treats an entry with a linked local md file as markdown', () => {
    expect(isMarkdownEntry({ title: 'Notes', md_path: 'C:\\docs\\notes.md' })).toBe(true)
    expect(isMarkdownEntry({ title: 'Notes', md_path: '   ' })).toBe(false)
    expect(isMarkdownEntry({ title: 'Notes', md_path: '' })).toBe(false)
  })
})
