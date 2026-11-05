import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HighlighterCategory, HighlighterConfig, HighlighterDigestItem } from '../types'
import { DEFAULT_CONFIG, classify, mergeConfig, normalizeColor, listNumber, parseInline, plainText, tagInstructions, withoutLabel } from './highlight'

const configAtom = atom({ plugin: 'highlighter', key: 'config' } as const, null)
const digestAtom = atom({ plugin: 'highlighter', key: 'digest' } as const, [])

const BAR = '▌ '

let problems: string[] = []

async function configPath($: EngineInterface): Promise<string> {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (dir) return `${dir.replace(/[\\/]+$/, '')}/highlighter.json`
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '.'
  return `${home.replace(/[\\/]+$/, '')}/.claude/highlighter.json`
}

/** Reads the file onto the defaults and publishes it; drawings that read it redraw when it changed. */
async function loadConfig($: EngineInterface): Promise<HighlighterConfig> {
  const path = await configPath($)
  let raw: unknown = {}
  problems = []
  if (await $.fs.exists(path)) {
    try {
      raw = JSON.parse(String(await $.fs.read(path)))
    } catch (error) {
      problems.push(`${path} is not valid JSON, using the defaults (${String(error)})`)
    }
  }
  const merged = mergeConfig(raw)
  problems.push(...merged.problems)
  await update($, configAtom, current =>
    JSON.stringify(current) === JSON.stringify(merged.config) ? current : merged.config,
  )
  return merged.config
}

async function readConfig($: EngineInterface): Promise<HighlighterConfig> {
  return (await read($, configAtom)) ?? DEFAULT_CONFIG
}

/** Changes the file itself, keeping whatever else the person wrote in it. */
async function editFile($: EngineInterface, change: (file: Record<string, any>) => void): Promise<void> {
  const path = await configPath($)
  const file: Record<string, any> = (await $.fs.exists(path))
    ? JSON.parse(String(await $.fs.read(path)))
    : structuredClone(DEFAULT_CONFIG)
  change(file)
  await $.fs.write(path, `${JSON.stringify(file, null, 2)}\n`)
}

const setCategory = (file: Record<string, any>, id: string, key: string, value: unknown) => {
  file.categories ??= {}
  file.categories[id] ??= {}
  file.categories[id][key] = value
}

const USAGE = [
  '- `/highlighter on|off`',
  '- `/highlighter enable|disable <category>`',
  '- `/highlighter color <category> <color>`',
  '- `/highlighter background <category> <color|none>`',
  '- `/highlighter label <category> <text>`',
  '- `/highlighter rules on|off` (the regex fallback)',
  '- `/highlighter digest on|off` (the list above the prompt)',
  '- `/highlighter style line|badge`',
  '- `/highlighter init` (write the full config file)',
  '- `/highlighter reset` (back to the defaults)',
].join('\n')

async function runCommand($: EngineInterface, args: string): Promise<{ text: string; context?: readonly string[] }> {
  const [verb = '', first, ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const path = await configPath($)
  const config = await loadConfig($)
  const isOnOff = first === 'on' || first === 'off'
  const unknownCategory = { text: `Unknown category. Categories: ${Object.keys(config.categories).join(', ')}` }

  const known = (id: string | undefined): id is string => id !== undefined && id in config.categories
  const apply = async (change: (file: Record<string, any>) => void, said: string) => {
    await editFile($, change)
    const fresh = await loadConfig($)
    // A running thread keeps the system prompt it started with, so the model hears it here.
    return {
      text: said,
      context: [fresh.enabled ? tagInstructions(fresh, path) : 'Highlighter is off: stop writing [!tag] prefixes.'],
    }
  }

  try {
    switch (verb) {
      case '':
      case 'status': {
        const lines = [
          `Highlighter is **${config.enabled ? 'on' : 'off'}**. Config: \`${path}\``,
          `Rules ${config.rules ? 'on' : 'off'}, digest ${config.digest.enabled ? 'on' : 'off'}, style ${config.style}.`,
        ]
        if (problems.length > 0) lines.push('', 'Problems in the config:', ...problems.map(p => `- ${p}`))
        return { text: `${lines.join('\n')}\n\n${USAGE}` }
      }
      case 'on':
      case 'off':
        return await apply(file => (file.enabled = verb === 'on'), `Highlighter ${verb}.`)
      case 'enable':
      case 'disable':
        if (!known(first)) return unknownCategory
        return await apply(file => setCategory(file, first, 'enabled', verb === 'enable'), `${first} ${verb}d.`)
      case 'color':
      case 'background': {
        const value = rest.join(' ')
        if (!known(first)) return unknownCategory
        if (verb === 'background' && value === 'none') {
          return await apply(file => setCategory(file, first, 'background', null), `${first} has no background now.`)
        }
        if (normalizeColor(value) === undefined) {
          return { text: `Unknown colour "${value}". Use hex (#ff8800), a terminal name (red, cyanBright), a theme key (error, success) or orange, pink, purple, teal, gold.` }
        }
        return await apply(file => setCategory(file, first, verb, value), `${first} ${verb} is ${value}.`)
      }
      case 'label':
        if (!known(first) || rest.length === 0) return { text: 'Usage: `/highlighter label <category> <text>`' }
        return await apply(file => setCategory(file, first, 'label', rest.join(' ')), `${first} label is ${rest.join(' ')}.`)
      case 'rules':
      case 'digest':
        if (!isOnOff) return { text: `Usage: \`/highlighter ${verb} on|off\`` }
        return await apply(file => {
          if (verb === 'rules') file.rules = first === 'on'
          else file.digest = { ...file.digest, enabled: first === 'on' }
        }, `${verb === 'rules' ? 'Rules' : 'Digest'} ${first}.`)
      case 'style':
        if (first !== 'line' && first !== 'badge') return { text: 'Usage: `/highlighter style line|badge`' }
        return await apply(file => (file.style = first), `Style is ${first}.`)
      case 'init':
        if (await $.fs.exists(path)) return { text: `Already there: \`${path}\`` }
        await editFile($, () => {})
        await loadConfig($)
        return { text: `Wrote \`${path}\`. Edits apply from your next prompt.` }
      case 'reset':
        return await apply(file => {
          for (const key of Object.keys(file)) delete file[key]
          Object.assign(file, structuredClone(DEFAULT_CONFIG))
        }, 'Back to the defaults.')
      default:
        return { text: USAGE }
    }
  } catch (error) {
    return { text: `Could not change \`${path}\`: ${String(error)}` }
  }
}

/** The lines of a long reply that need the person, for the band above the prompt. */
function digestOf(answer: string, config: HighlighterConfig): HighlighterDigestItem[] {
  if (!config.enabled || !config.digest.enabled) return []
  if (answer.split('\n').length < config.digest.minReplyLines) return []
  return classify(answer, config)
    .segments.flatMap(s => (s.kind === 'hit' && config.categories[s.id]?.digest ? [{ id: s.id, text: plainText(withoutLabel(s.body, config.categories[s.id]!.label)) }] : []))
    .slice(0, config.digest.maxItems)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await loadConfig($)
    await $.command.register({
      name: 'highlighter',
      description: 'Show or change what gets highlighted in replies',
      argumentHint: '[on|off|color <category> <color>|...]',
    })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // Hand edits to the file take effect here, and the last digest is done with.
    await loadConfig($)
    await update($, digestAtom, current => (current.length === 0 ? current : []))
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const isHeadless = e.surfaces.length === 0 || e.traits.some(t => t === 'print' || t === 'teammate' || t === 'analysis' || t === 'sdk-preset')
    const config = await readConfig($)
    if (isHeadless || !config.enabled) return result
    return {
      sections: [
        ...result.sections,
        { id: 'highlighter:tags', text: tagInstructions(config, await configPath($)), scope: 'session' as const },
      ],
    }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.reason === 'answer') {
      const items = digestOf(e.answer, await readConfig($))
      await update($, digestAtom, () => items)
    }
    return next(e)
  })

  on('command.run', { command: 'highlighter' }, ($, e) => runCommand($, e.args))

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary) return next(e)
    const config = await readConfig($)
    const { segments, hasHits, stripped, isChanged } = classify(e.props.text, config)
    if (!hasHits) return isChanged ? next({ ...e, props: { ...e.props, text: stripped } }) : next(e)

    const { Box, Markdown, Text } = $.ui.resolve(e)
    // Answering with a tree replaces the whole row, so the reply's own bullet and gutter are drawn here.
    return (
      <Box flexDirection="row" marginTop={1}>
        <Box flexShrink={0} width={2}>
          <Text>{e.props.isFirstOfReply ? '● ' : '  '}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {segments.map(segment => (
            <Box marginTop={segment.gapBefore ? 1 : 0}>
              {segment.kind === 'plain' ? (
                <Markdown text={segment.text} />
              ) : (
                hitRow(Box, Text, segment.marker, segment.body, config.categories[segment.id]!, config.style)
              )}
            </Box>
          ))}
        </Box>
      </Box>
    )
  })

  // The legend: each category drawn as it would appear, so a colour change can be seen at once.
  on('ui.render', { component: 'CommandOutput', props: { command: 'highlighter' } }, async ($, e, next) => {
    if (e.props.isErrored) return next(e)
    const config = await readConfig($)
    const { Box, Markdown, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Markdown text={e.props.text} />
        <Box flexDirection="column" marginTop={1}>
          {Object.entries(config.categories).map(([id, category]) =>
            category.enabled ? (
              hitRow(Box, Text, '', `\`[!${id}]\` ${category.description}`, category, config.style)
            ) : (
              <Text dimColor>
                {BAR}
                {id} is disabled
              </Text>
            ),
          )}
        </Box>
      </Box>
    )
  })

  // The digest: after a long reply, what needs the person is repeated right above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isWorking) return next(e)
    const items = await read($, digestAtom)
    if (items.length === 0) return next(e)
    const config = await readConfig($)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text dimColor>In that reply, for you:</Text>
        {items.map(item => {
          const category = config.categories[item.id]
          if (category === undefined) return <Text wrap="truncate-end">{item.text}</Text>
          return (
            <Text wrap="truncate-end" color={category.color}>
              {BAR}
              <Text weight="bold">{category.label}</Text> {item.text}
            </Text>
          )
        })}
      </Box>
    )
  })
}

/** A highlighted line: bar, label, then the words. Wrapped rows hang under the words. */
function hitRow(Box: any, Text: any, marker: string, body: string, category: HighlighterCategory, style: HighlighterConfig['style']) {
  const paint = style === 'line' ? { color: category.color, backgroundColor: category.background } : {}
  return (
    <Box flexDirection="row">
      <Box flexShrink={0}>
        <Text color={category.color}>{BAR}</Text>
        {category.label !== '' ? (
          <Text color={category.color} weight="bold" inverse>
            {` ${category.label} `}
          </Text>
        ) : null}
        <Text> {listNumber(marker)}</Text>
      </Box>
      <Box flexShrink={1} flexGrow={1}>
        <Text {...paint} weight={category.bold ? 'bold' : undefined}>
          {parseInline(withoutLabel(body, category.label)).map(run => (
            <Text weight={run.bold ? 'bold' : undefined} italic={run.italic} underline={run.code}>
              {run.text}
            </Text>
          ))}
        </Text>
      </Box>
    </Box>
  )
}
