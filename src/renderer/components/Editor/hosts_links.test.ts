import { describe, expect, it } from 'vitest'
import { getCommentLinks } from './hosts_links'

const urls = (line: string) => getCommentLinks(line).map((l) => l.url)

describe('getCommentLinks', () => {
  it('ignores lines without a comment', () => {
    expect(urls('127.0.0.1 example.com')).toEqual([])
    expect(urls('https://example.com/a')).toEqual([])
  })

  it('finds links inside full-line and inline comments', () => {
    expect(urls('# source https://example.com/list')).toEqual(['https://example.com/list'])
    expect(urls('127.0.0.1 a.com # see http://docs.test/x')).toEqual([
      'http://docs.test/x',
    ])
  })

  it('strips trailing prose punctuation', () => {
    expect(urls('# 见 https://example.com/a.')).toEqual(['https://example.com/a'])
    expect(urls('# 见 https://example.com/a，然后')).toEqual(['https://example.com/a'])
  })

  it('keeps balanced brackets and drops unmatched ones', () => {
    expect(urls('# https://example.com/wiki/Foo_(bar)')).toEqual([
      'https://example.com/wiki/Foo_(bar)',
    ])
    expect(urls('# (see https://example.com/a)')).toEqual(['https://example.com/a'])
  })

  it('reports offsets relative to the line start', () => {
    const line = '127.0.0.1 a.com # https://x.test/p'
    const [link] = getCommentLinks(line)
    expect(line.slice(link.from, link.to)).toBe('https://x.test/p')
  })

  it('skips text that is not a valid URL', () => {
    expect(urls('# https://')).toEqual([])
    expect(urls('# https:///nohost')).toEqual([])
  })
})
