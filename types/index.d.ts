// The values this plugin keeps in $.state. Plain data, so they survive a hot reload.
export type HighlighterConfig = {
  enabled: boolean
  rules: boolean
  style: 'line' | 'badge'
  digest: { enabled: boolean; minReplyLines: number; maxItems: number }
  categories: Record<string, HighlighterCategory>
}

export type HighlighterCategory = {
  enabled: boolean
  label: string
  color: string
  background?: string
  bold: boolean
  digest: boolean
  description: string
  patterns: string[]
}

export type HighlighterDigestItem = { id: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    highlighter: {
      config: HighlighterConfig | null
      digest: HighlighterDigestItem[]
    }
  }
}
