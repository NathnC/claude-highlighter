// Pure logic: defaults, config merging, line classification and inline markdown.
// Nothing here touches the engine, so it is all unit-testable.
import type { HighlighterCategory, HighlighterConfig } from '../types'

export const DEFAULT_CONFIG: HighlighterConfig = {
  enabled: true,
  rules: true,
  style: 'line',
  digest: { enabled: true, minReplyLines: 12, maxItems: 6 },
  categories: {
    critical: {
      enabled: true,
      label: 'CRITICAL',
      color: 'error',
      bold: true,
      digest: true,
      description: 'data loss, security holes, production breakage, anything dangerous or irreversible',
      patterns: [
        '^(critical|blocker|danger|data loss|breaking change|security (issue|risk|hole|vulnerability))\\b',
        "\\b(irreversible|cannot be undone|can't be undone)\\b",
      ],
    },
    warning: {
      enabled: true,
      label: 'WARNING',
      color: 'warning',
      bold: false,
      digest: false,
      description: 'failures, skipped steps, risks and caveats that change what the person should do',
      patterns: [
        '^(warning|caution|heads[- ]up|watch out|beware)\\b',
        "^(failed|couldn't|could not|unable to)\\b",
        '^(the )?(tests?|build|ci|deploy(ment)?|push|install|migration)\\b.{0,60}\\b(fail(s|ed|ing)?|broke|broken|errored)\\b',
      ],
    },
    action: {
      enabled: true,
      label: 'ACTION',
      color: 'cyan',
      bold: true,
      digest: true,
      description: 'something the person has to do themselves: run a command, restart, approve, configure',
      patterns: [
        '^(action( required)?|todo|to do|next steps?|manual step)\\b',
        "^(you|you'll) (need|have|must)\\b",
        '^please (run|restart|add|set|review|confirm|check|update|install|approve)\\b',
        "^(remember to|don't forget|make sure you)\\b",
      ],
    },
    question: {
      enabled: true,
      label: 'QUESTION',
      color: 'merged',
      bold: false,
      digest: true,
      description: 'a decision or answer you need from the person before continuing',
      patterns: ['^(want me to|should i|do you want|would you like|shall i|can you confirm|ok to)\\b.*\\?$'],
    },
    change: {
      enabled: true,
      label: 'CHANGE',
      color: 'success',
      bold: false,
      digest: false,
      description: 'a notable change you made: what was added, fixed, removed or deployed',
      patterns: [
        '^(added|changed|created|deleted|fixed|implemented|moved|refactored|removed|renamed|replaced|updated|rewrote|merged|pushed|committed|deployed|bumped|migrated)\\b',
      ],
    },
  },
}

// Names people reach for that terminals do not know. Everything else passes through
// to the renderer: terminal names (red, cyanBright), theme keys (error, success) and hex.
const NAMED_COLORS: Record<string, string> = {
  orange: '#ff9f43',
  amber: '#ffbf00',
  gold: '#ffd700',
  pink: '#ff79c6',
  purple: '#b48cff',
  violet: '#8f7bff',
  teal: '#2ec4b6',
  lime: '#a3e635',
  coral: '#ff7f6e',
  navy: '#3b6fd4',
  brown: '#b5835a',
}

const TERMINAL_COLORS = new Set(
  ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray', 'grey'].flatMap(c => [c, `${c}Bright`]),
)

const THEME_KEYS = new Set([
  'text', 'inverseText', 'inactive', 'subtle', 'suggestion', 'remember', 'success', 'error',
  'warning', 'merged', 'claude', 'permission', 'planMode', 'autoAccept',
])

/** A colour the renderer can draw, or undefined when the words name none. */
export function normalizeColor(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined
  const color = input.trim()
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) return color
  if (/^(rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|ansi256\(\s*\d{1,3}\s*\))$/.test(color)) return color
  if (TERMINAL_COLORS.has(color) || THEME_KEYS.has(color)) return color
  return NAMED_COLORS[color.toLowerCase()]
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const int = (v: unknown, fallback: number, min: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.floor(v)) : fallback

const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)

function mergeCategory(id: string, base: HighlighterCategory | undefined, raw: unknown, problems: string[]): HighlighterCategory {
  const over = isObject(raw) ? raw : {}
  const fallbackColor = base?.color ?? 'text'
  const color = over.color === undefined ? fallbackColor : normalizeColor(over.color)
  if (color === undefined) problems.push(`${id}: unknown color ${JSON.stringify(over.color)}`)
  const hasBackground = over.background !== undefined && over.background !== null
  const background = hasBackground ? normalizeColor(over.background) : undefined
  if (hasBackground && background === undefined) problems.push(`${id}: unknown background ${JSON.stringify(over.background)}`)
  const patterns = Array.isArray(over.patterns)
    ? over.patterns.filter((p): p is string => typeof p === 'string')
    : (base?.patterns ?? [])
  for (const p of patterns) if (compile(p) === null) problems.push(`${id}: bad pattern ${JSON.stringify(p)}`)
  const merged: HighlighterCategory = {
    enabled: bool(over.enabled, base?.enabled ?? true),
    label: typeof over.label === 'string' ? over.label : (base?.label ?? id.toUpperCase()),
    color: color ?? fallbackColor,
    bold: bool(over.bold, base?.bold ?? false),
    digest: bool(over.digest, base?.digest ?? false),
    description: typeof over.description === 'string' ? over.description : (base?.description ?? id),
    patterns,
  }
  if (background !== undefined) merged.background = background
  return merged
}

/** Lays a user's file over the defaults; anything it gets wrong falls back and is reported. */
export function mergeConfig(raw: unknown): { config: HighlighterConfig; problems: string[] } {
  const problems: string[] = []
  const over = isObject(raw) ? raw : {}
  const digest = isObject(over.digest) ? over.digest : {}
  const rawCategories = isObject(over.categories) ? over.categories : {}
  const categories: Record<string, HighlighterCategory> = {}
  for (const [id, base] of Object.entries(DEFAULT_CONFIG.categories)) {
    categories[id] = mergeCategory(id, base, rawCategories[id], problems)
  }
  for (const [id, value] of Object.entries(rawCategories)) {
    if (id in DEFAULT_CONFIG.categories) continue
    if (!/^[a-z][\w-]*$/.test(id)) {
      problems.push(`${id}: a category id is lowercase letters, digits, - and _`)
      continue
    }
    categories[id] = mergeCategory(id, undefined, value, problems)
  }
  return {
    problems,
    config: {
      enabled: bool(over.enabled, DEFAULT_CONFIG.enabled),
      rules: bool(over.rules, DEFAULT_CONFIG.rules),
      style: over.style === 'badge' ? 'badge' : 'line',
      digest: {
        enabled: bool(digest.enabled, DEFAULT_CONFIG.digest.enabled),
        minReplyLines: int(digest.minReplyLines, DEFAULT_CONFIG.digest.minReplyLines, 0),
        maxItems: int(digest.maxItems, DEFAULT_CONFIG.digest.maxItems, 1),
      },
      categories,
    },
  }
}

const compiled = new Map<string, RegExp | null>()

function compile(pattern: string): RegExp | null {
  let re = compiled.get(pattern)
  if (re === undefined) {
    try {
      re = new RegExp(pattern, 'i')
    } catch {
      re = null
    }
    compiled.set(pattern, re)
  }
  return re
}

export type Segment =
  | { kind: 'plain'; text: string; gapBefore: boolean }
  | { kind: 'hit'; id: string; marker: string; body: string; gapBefore: boolean }

export type Classified = {
  segments: Segment[]
  /** Whether any line is highlighted. */
  hasHits: boolean
  /** The text with the tags gone, for when nothing is highlighted but a tag had to be hidden. */
  stripped: string
  /** Whether `stripped` differs from what came in. */
  isChanged: boolean
}

const TAG = /^(\s*(?:[-*+]\s+|\d+[.)]\s+)?)(\*\*|__)?\[!([A-Za-z][\w-]*)\](\*\*|__)?[ \t]*(.*)$/
const LIST_MARKER = /^(\s*(?:[-*+]\s+|\d+[.)]\s+)?)(.*)$/
const FENCE = /^\s*(```|~~~)/
const PARTIAL_TAG = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)?\[(?:!(?:[A-Za-z][\w-]*)?)?$/
const NOT_PROSE = /^\s*(\||#{1,6}\s|>|---+\s*$|===+\s*$)/

/** A category id a line's tag names, when the config knows it. */
function tagIdOf(line: string, config: HighlighterConfig): string | undefined {
  const id = TAG.exec(line)?.[3]?.toLowerCase()
  return id !== undefined && id in config.categories ? id : undefined
}

/** A line with its emphasis and leading symbols gone, the form the rules read. */
function forRules(body: string): string {
  return body
    .replace(/(\*\*|__|`)/g, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim()
}

function classifyByRules(body: string, config: HighlighterConfig): string | undefined {
  const line = forRules(body)
  if (line === '') return undefined
  for (const [id, category] of Object.entries(config.categories)) {
    if (!category.enabled) continue
    if (category.patterns.some(p => compile(p)?.test(line))) return id
  }
  return undefined
}

function lineIsHit(line: string, hasTags: boolean, config: HighlighterConfig): boolean {
  if (!config.enabled) return false
  const tagId = tagIdOf(line, config)
  if (tagId !== undefined) return config.categories[tagId]?.enabled === true
  if (!config.rules || hasTags || NOT_PROSE.test(line) || FENCE.test(line)) return false
  return classifyByRules(LIST_MARKER.exec(line)?.[2] ?? line, config) !== undefined
}

/**
 * Splits a reply into runs to draw as ordinary markdown and lines to highlight.
 *
 * A `[!id]` tag the model wrote always wins and is always hidden. The regex rules are the
 * fallback: they only read a reply holding no tag at all, so a tagging model stays precise.
 */
export function classify(text: string, config: HighlighterConfig): Classified {
  const lines = text.split('\n')

  let isInFence = false
  let hasTags = false
  for (const line of lines) {
    if (FENCE.test(line)) isInFence = !isInFence
    else if (!isInFence && tagIdOf(line, config) !== undefined) hasTags = true
  }

  const segments: Segment[] = []
  const strippedLines: string[] = []
  let plain: string[] = []
  let pendingGap = false
  let plainGap = false
  let isChanged = false
  isInFence = false

  const flush = () => {
    if (plain.length === 0) return
    segments.push({ kind: 'plain', text: plain.join('\n'), gapBefore: plainGap })
    plain = []
  }
  const addPlain = (line: string) => {
    if (plain.length === 0) plainGap = pendingGap
    plain.push(line)
    pendingGap = false
  }

  lines.forEach((line, index) => {
    if (FENCE.test(line) || isInFence) {
      if (FENCE.test(line)) isInFence = !isInFence
      addPlain(line)
      strippedLines.push(line)
      return
    }
    if (line.trim() === '') {
      strippedLines.push(line)
      if (plain.length === 0) {
        pendingGap = segments.length > 0
        return
      }
      // A blank inside a run of ordinary markdown stays in it, unless the run ends here.
      const following = lines.slice(index + 1).find(l => l.trim() !== '')
      if (following === undefined || lineIsHit(following, hasTags, config)) pendingGap = true
      else plain.push(line)
      return
    }

    if (index === lines.length - 1 && PARTIAL_TAG.test(line)) {
      // Still streaming: a tag half written is not drawn.
      isChanged = true
      return
    }

    const tagId = tagIdOf(line, config)
    if (tagId !== undefined) {
      const tag = TAG.exec(line)
      const open = tag?.[2] ?? ''
      const close = tag?.[4] ?? ''
      const rest = tag?.[5] ?? ''
      // `**[!action] do it**`: the emphasis belongs to the words, so it stays with them.
      const body = open !== '' && close === '' ? `${open}${rest}` : rest
      const marker = tag?.[1] ?? ''
      isChanged = true
      if (body.trim() === '') return
      strippedLines.push(`${marker}${body}`)
      if (config.enabled && config.categories[tagId]?.enabled) {
        flush()
        segments.push({ kind: 'hit', id: tagId, marker, body, gapBefore: pendingGap })
        pendingGap = false
      } else {
        addPlain(`${marker}${body}`)
      }
      return
    }

    strippedLines.push(line)
    if (lineIsHit(line, hasTags, config)) {
      const parts = LIST_MARKER.exec(line)
      const body = parts?.[2] ?? line
      const id = classifyByRules(body, config)
      if (id !== undefined) {
        flush()
        segments.push({ kind: 'hit', id, marker: parts?.[1] ?? '', body, gapBefore: pendingGap })
        pendingGap = false
        return
      }
    }
    addPlain(line)
  })
  flush()

  return {
    segments,
    hasHits: segments.some(s => s.kind === 'hit'),
    stripped: strippedLines.join('\n'),
    isChanged,
  }
}

export type InlineRun = { text: string; bold?: boolean; italic?: boolean; code?: boolean }

const INLINE = /(\*\*|__)(.+?)\1|`([^`]+)`|(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])|\[([^\]]+)\]\(([^)\s]+)\)/g

/** A highlighted line is drawn as coloured text, so its inline markdown is read here. */
export function parseInline(text: string): InlineRun[] {
  const runs: InlineRun[] = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index
    if (at > last) runs.push({ text: text.slice(last, at) })
    if (m[2] !== undefined) runs.push({ text: m[2].replace(/`/g, ''), bold: true })
    else if (m[3] !== undefined) runs.push({ text: m[3], code: true })
    else if (m[4] !== undefined) runs.push({ text: m[4], italic: true })
    else if (m[5] !== undefined) {
      const url = m[6] ?? ''
      runs.push({ text: m[5] === url ? url : `${m[5]} (${url})` })
    }
    last = at + m[0].length
  }
  if (last < text.length) runs.push({ text: text.slice(last) })
  return runs
}

/** The badge already says it: "**Warning:** the build failed" reads "the build failed". */
export function withoutLabel(body: string, label: string): string {
  if (label === '') return body
  const name = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const emphasis = '(?:\\*\\*|__)'
  const lead = new RegExp(`^${emphasis}?${name}(?::${emphasis}?|${emphasis}?:)\\s+`, 'i')
  return body.replace(lead, '')
}

/** A bullet would only sit between the badge and the words; a number still means something. */
export function listNumber(marker: string): string {
  return /\d/.test(marker) ? marker.trimStart() : ''
}

export const plainText = (text: string) => parseInline(text).map(r => r.text).join('')

/** What the model is told, built from the config so a custom category is taught too. */
export function tagInstructions(config: HighlighterConfig, configPath: string): string {
  const rows = Object.entries(config.categories)
    .filter(([, c]) => c.enabled)
    .map(([id, c]) => `[!${id}] ${c.description}`)
  return [
    '# Highlighter',
    "The person's terminal colours key lines of your replies so they can jump straight to what needs them. In the message that ends a task, start a line or bullet with one of these tags when it holds something they must not miss:",
    ...rows,
    'Tag sparingly: most replies need zero to five tags, and a tag on every line helps nobody. The tag comes first on the line (after any bullet marker), is hidden from the person, and covers that one line, so the line must read naturally without it. Use tags only in your own replies: never in code blocks, tables, files, commit messages, tool input or prompts for subagents.',
    `The colours and rules live in ${configPath}. If asked to change what gets highlighted, edit that JSON (keys: enabled, rules, style, digest, categories.<id>.{enabled,label,color,background,bold,digest,description,patterns}) or suggest the /highlighter command. Edits apply from the next prompt.`,
  ].join('\n')
}
