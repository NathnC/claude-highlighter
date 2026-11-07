import { expect, test } from 'claude-code/testing'

import { DEFAULT_CONFIG, classify, groupHits, mergeConfig, normalizeColor, parseInline, tagInstructions, withoutLabel } from '../hooks/highlight'

const ids = (text: string, config = DEFAULT_CONFIG) =>
  classify(text, config).segments.flatMap(s => (s.kind === 'hit' ? [s.id] : []))

const message = (text: string, surface: 'terminal' | 'desktop' | 'vscode' | 'mobile') => ({
  plugin: 'highlighter',
  surface,
  component: 'AssistantMessage',
  requestId: 'm1',
  props: { text, isFirstOfReply: true },
}) as const

test('a tag decides the category and is hidden', () => {
  const { segments, stripped } = classify('[!action] Run `npm i`\nplain words', DEFAULT_CONFIG)
  expect(segments[0]).toEqual({ kind: 'hit', id: 'action', marker: '', body: 'Run `npm i`', gapBefore: false })
  expect(stripped).toBe('Run `npm i`\nplain words')
})

test('a tag after a bullet or inside emphasis is read', () => {
  expect(ids('- [!change] Added it')).toEqual(['change'])
  expect(ids('1. [!critical] Danger')).toEqual(['critical'])
  expect(ids('**[!warning]** Careful now')).toEqual(['warning'])
  const { segments } = classify('**[!warning] Careful now**', DEFAULT_CONFIG)
  expect(segments[0]).toMatchObject({ body: '**Careful now**' })
})

test('fenced code is never touched', () => {
  const text = '```\n[!action] not a tag\nAdded nothing\n```'
  const { segments, hasHits, isChanged } = classify(text, DEFAULT_CONFIG)
  expect(hasHits).toBe(false)
  expect(isChanged).toBe(false)
  expect(segments).toEqual([{ kind: 'plain', text, gapBefore: false }])
})

test('tables, headings and quotes are left to the rules-free path', () => {
  expect(ids('| Added | a table cell |')).toEqual([])
  expect(ids('# Added a heading')).toEqual([])
  expect(ids('> Added a quote')).toEqual([])
})

test('the rules fall back only when the reply holds no tag', () => {
  expect(ids('Added a retry\nFixed the test')).toEqual(['change', 'change'])
  expect(ids('Added a retry\n[!action] Do this')).toEqual(['action'])
})

test('the rules read the start of a line, not any mention', () => {
  expect(ids('The word warning mid sentence')).toEqual([])
  expect(ids('**Warning:** careful')).toEqual(['warning'])
  expect(ids('⚠️ Warning: careful')).toEqual(['warning'])
  expect(ids('You need to run it')).toEqual(['action'])
  expect(ids('Want me to open a PR?')).toEqual(['question'])
  expect(ids('Want me to open a PR')).toEqual([])
  expect(ids('Tests failed on CI')).toEqual(['warning'])
  expect(ids('This cannot be undone')).toEqual(['critical'])
})

test('a half written tag at the end of a stream is not drawn', () => {
  const { stripped, isChanged } = classify('Words\n[!acti', DEFAULT_CONFIG)
  expect(stripped).toBe('Words')
  expect(isChanged).toBe(true)
})

test('an unknown tag stays as written, a disabled one is hidden', () => {
  expect(classify('[!nope] words', DEFAULT_CONFIG).stripped).toBe('[!nope] words')
  const { config } = mergeConfig({ categories: { action: { enabled: false } } })
  const result = classify('[!action] words', config)
  expect(result.hasHits).toBe(false)
  expect(result.stripped).toBe('words')
})

test('switched off, tags are still hidden and nothing is coloured', () => {
  const { config } = mergeConfig({ enabled: false })
  const result = classify('[!critical] words\nAdded x', config)
  expect(result.hasHits).toBe(false)
  expect(result.stripped).toBe('words\nAdded x')
})

test('rules off means tags only', () => {
  const { config } = mergeConfig({ rules: false })
  expect(ids('Added a retry', config)).toEqual([])
  expect(ids('[!change] Added a retry', config)).toEqual(['change'])
})

test('blank lines become gaps around highlights', () => {
  const { segments } = classify('Intro\n\n[!action] Do it\n\nOutro', DEFAULT_CONFIG)
  expect(segments.map(s => s.gapBefore)).toEqual([false, true, true])
})

const shape = (text: string) =>
  groupHits(classify(text, DEFAULT_CONFIG).segments).map(b => (b.kind === 'plain' ? 'plain' : `${b.id}:${b.items.length}`))

test('neighbouring lines of one category group, whatever the blank lines between them', () => {
  expect(shape('[!warning] a\n[!warning] b\n[!warning] c')).toEqual(['warning:3'])
  expect(shape('- [!warning] a\n\n- [!warning] b')).toEqual(['warning:2'])
})

test('a different category or ordinary text ends a group', () => {
  expect(shape('[!warning] a\n[!action] b\n[!warning] c')).toEqual(['warning:1', 'action:1', 'warning:1'])
  expect(shape('[!warning] a\nwords\n[!warning] b')).toEqual(['warning:1', 'plain', 'warning:1'])
})

test('a group keeps each line and the gap before its first', () => {
  const [, group] = groupHits(classify('Intro\n\n1. [!action] a\n2. [!action] b', DEFAULT_CONFIG).segments)
  expect(group).toEqual({
    kind: 'group',
    id: 'action',
    gapBefore: true,
    items: [
      { marker: '1. ', body: 'a' },
      { marker: '2. ', body: 'b' },
    ],
  })
})

test('the config overlays the defaults and reports what it cannot use', () => {
  const { config, problems } = mergeConfig({
    digest: { maxItems: 2 },
    categories: {
      action: { color: 'orange', label: 'YOU' },
      warning: { color: 'not-a-colour' },
      change: { patterns: ['('] },
      deploy: { color: '#123456', description: 'a deploy', patterns: ['^shipped\\b'] },
      'Bad Id': {},
    },
  })
  expect(config.categories.action).toMatchObject({ color: '#ff9f43', label: 'YOU', bold: true })
  expect(config.categories.warning?.color).toBe('warning')
  expect(config.categories.deploy).toMatchObject({ color: '#123456', label: 'DEPLOY', enabled: true })
  expect(config.digest).toEqual({ enabled: true, minReplyLines: 12, maxItems: 2 })
  expect(problems.length).toBe(3)
  expect(ids('Shipped the thing', config)).toEqual(['deploy'])
})

test('a broken pattern does not stop the others', () => {
  const { config } = mergeConfig({ categories: { change: { patterns: ['(', '^added\\b'] } } })
  expect(ids('Added it', config)).toEqual(['change'])
})

test('colours', () => {
  expect(normalizeColor('#FF8800')).toBe('#FF8800')
  expect(normalizeColor('#f80')).toBe('#f80')
  expect(normalizeColor('cyanBright')).toBe('cyanBright')
  expect(normalizeColor('error')).toBe('error')
  expect(normalizeColor('orange')).toBe('#ff9f43')
  expect(normalizeColor('rgb(1, 2, 3)')).toBe('rgb(1, 2, 3)')
  expect(normalizeColor('blurple')).toBe(undefined)
  expect(normalizeColor(7)).toBe(undefined)
})

test('inline markdown', () => {
  expect(parseInline('a **b** `c` *d* [e](https://f.g)')).toEqual([
    { text: 'a ' },
    { text: 'b', bold: true },
    { text: ' ' },
    { text: 'c', code: true },
    { text: ' ' },
    { text: 'd', italic: true },
    { text: ' ' },
    { text: 'e (https://f.g)' },
  ])
  expect(parseInline('2 * 3 * 4 snake_case_name')).toEqual([{ text: '2 * 3 * 4 snake_case_name' }])
})

test('the label is not said twice', () => {
  expect(withoutLabel('**Warning:** the build failed', 'WARNING')).toBe('the build failed')
  expect(withoutLabel('Warning: the build failed', 'WARNING')).toBe('the build failed')
  expect(withoutLabel('Warnings pile up', 'WARNING')).toBe('Warnings pile up')
})

test('the instructions teach every enabled category and name the file', () => {
  const { config } = mergeConfig({ categories: { change: { enabled: false }, deploy: { description: 'a deploy' } } })
  const text = tagInstructions(config, '/home/x/.claude/highlighter.json')
  expect(text).toContain('[!action]')
  expect(text).toContain('[!deploy] a deploy')
  expect(text).not.toContain('[!change]')
  expect(text).toContain('/home/x/.claude/highlighter.json')
})

test('a reply with something flagged is drawn with its label on every surface', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount(message('Intro\n\n[!critical] Back it up **first**', surface))
    expect((await ui.find({ type: 'Text', text: / CRITICAL / }))?.text).toBe(' CRITICAL ')
    expect((await ui.find({ type: 'Text', text: /Back it up/ }))?.text).toBe('Back it up first')
    expect(await ui.find({ type: 'Text', text: /\[!critical\]/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /engine/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('a run of warnings wears one badge and keeps every line', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount(message('[!warning] First\n[!warning] Second\n[!warning] Third\n\n[!action] Do it', 'terminal'))
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts.filter(t => t === ' WARNING ').length).toBe(1)
  expect(texts.filter(t => t === ' ACTION ').length).toBe(1)
  for (const line of ['First', 'Second', 'Third', 'Do it']) expect(texts).toContain(line)
  await ui.unmount()
})

test('a reply with nothing flagged goes to the engine as it was', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{`engine: ${(e.props as { text: string }).text}`}</Text>
  })
  const ui = await $.ui.mount(message('Nothing to see here', 'terminal'))
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine: Nothing to see here')
  await ui.unmount()
})

test('a summary row is never touched', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const base = message('[!critical] Words', 'terminal')
  const ui = await $.ui.mount({ ...base, props: { ...base.props, isSummary: true } })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})
