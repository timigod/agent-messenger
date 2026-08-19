/**
 * Builds the Skype/Teams chat-send POST body.
 *
 * Incoming realtime mentions (trouter.ts) use a Skype Mention span plus
 * `properties.mentions`. Outgoing send must match that, not Graph-style
 * `<at id="8:orgid:…">` alone — the messaging API ignores those without
 * itemid-based markup and a mentions property.
 */

import { markdownToHtml } from '@/shared/utils/markdown-to-html'

import { sanitizeTeamsHtml } from './html-sanitizer'
import type { TeamsAccountType, TeamsMessageFormat } from './types'

const PERSON_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const AT_MENTION_PATTERN = /<at\s+id="([^"]*)">(.*?)<\/at>/gi
const SKYPE_MENTION_ITEMTYPE = 'http://schema.skype.com/Mention'

export interface ChatSendMention {
  mri: string
  displayName: string
}

export interface ChatSendPayload {
  content: string
  messagetype: 'RichText/Html'
  contenttype: 'text'
  properties?: { mentions: string }
}

interface MentionProperty {
  itemid: number
  mri: string
  mentionType: 'person'
  displayName: string
}

export function buildChatSendPayload(
  content: string,
  options?: {
    format?: TeamsMessageFormat
    mentions?: ChatSendMention[]
    accountType?: TeamsAccountType
  },
): ChatSendPayload {
  const format = options?.format ?? 'text'
  const accountType = options?.accountType ?? 'work'
  let html = formatContent(content, format)
  const rewritten = applyMentions(html, options?.mentions, accountType)
  html = rewritten.html
  if (format !== 'markdown') {
    html = preserveRichTextBreaks(html)
  }

  const payload: ChatSendPayload = {
    content: html,
    messagetype: 'RichText/Html',
    contenttype: 'text',
  }
  if (rewritten.mentions.length > 0) {
    payload.properties = { mentions: JSON.stringify(rewritten.mentions) }
  }
  return payload
}

function formatContent(content: string, format: TeamsMessageFormat): string {
  if (format === 'html') return sanitizeTeamsHtml(content)
  return format === 'markdown' ? markdownToHtml(content) : escapeHtml(content)
}

export function preserveRichTextBreaks(html: string): string {
  return html.replace(/\r\n?/g, '\n').replace(/\n{2,}/g, '<br/><br/>').replace(/\n/g, '<br/>')
}

function applyMentions(
  html: string,
  extraMentions: ChatSendMention[] | undefined,
  accountType: TeamsAccountType,
): { html: string; mentions: MentionProperty[] } {
  const mentions: MentionProperty[] = []
  let rewritten = html.replace(AT_MENTION_PATTERN, (_full, rawId: string, inner: string) => {
    const displayName = mentionDisplayName(inner)
    const mri = coerceMentionMri(rawId, accountType)
    if (!mri) {
      return /^\d+$/.test(rawId.trim()) ? mentionSpan(Number(rawId), displayName) : _full
    }
    const itemid = mentions.length
    mentions.push({ itemid, mri, mentionType: 'person', displayName })
    return mentionSpan(itemid, displayName)
  })

  for (const extra of extraMentions ?? []) {
    const mri = coerceMentionMri(extra.mri, accountType)
    const displayName = extra.displayName.trim()
    if (!mri || !displayName) continue
    if (mentions.some((mention) => mention.mri.toLowerCase() === mri.toLowerCase())) continue
    const needle = `@${displayName}`
    if (!rewritten.includes(needle)) continue
    const itemid = mentions.length
    mentions.push({ itemid, mri, mentionType: 'person', displayName })
    rewritten = rewritten.replaceAll(needle, mentionSpan(itemid, displayName))
  }

  return { html: rewritten, mentions }
}

function mentionSpan(itemid: number, displayName: string): string {
  return `<span itemtype="${SKYPE_MENTION_ITEMTYPE}" itemscope itemid="${itemid}">${escapeHtml(displayName)}</span>`
}

function mentionDisplayName(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function coerceMentionMri(id: string, accountType: TeamsAccountType): string | undefined {
  const raw = id.trim()
  if (!raw || /^\d+$/.test(raw)) return undefined
  const lower = raw.toLowerCase()
  if (lower.startsWith('8:orgid:') || lower.startsWith('8:live:')) return raw
  if (lower.startsWith('orgid:') || lower.startsWith('live:')) return `8:${raw}`
  if (PERSON_UUID.test(raw)) {
    return accountType === 'personal' ? `8:live:${raw}` : `8:orgid:${raw}`
  }
  return undefined
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
