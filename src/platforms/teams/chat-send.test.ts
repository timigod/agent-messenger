import { expect, it } from 'bun:test'

import { buildChatSendPayload, preserveRichTextBreaks } from './chat-send'

const GRACE_MRI = '8:orgid:c281778c-e71c-415a-8625-ab1f85b9eda9'
const TIMI_MRI = '8:orgid:963d98fa-49d7-4592-a0d9-73df250557f0'

it('rewrites Graph-style at-mentions into Skype spans and properties.mentions', () => {
  const payload = buildChatSendPayload(`Hey <at id="${GRACE_MRI}">Grace Hardy</at>`, { format: 'html' })

  expect(payload.messagetype).toBe('RichText/Html')
  expect(payload.contenttype).toBe('text')
  expect(payload.content).toBe(
    'Hey <span itemtype="http://schema.skype.com/Mention" itemscope itemid="0">Grace Hardy</span>',
  )
  expect(payload.properties?.mentions).toBe(
    JSON.stringify([{ itemid: 0, mri: GRACE_MRI, mentionType: 'person', displayName: 'Grace Hardy' }]),
  )
})

it('does not leave an MRI in the at-id', () => {
  const payload = buildChatSendPayload(`<at id="${GRACE_MRI}">Grace Hardy</at>`, { format: 'html' })

  expect(payload.content).not.toContain(GRACE_MRI)
  expect(payload.content).toContain('itemid="0"')
  expect(payload.properties?.mentions).toContain(GRACE_MRI)
})

it('assigns sequential itemids for multiple mentions', () => {
  const payload = buildChatSendPayload(
    `<at id="${GRACE_MRI}">Grace Hardy</at> and <at id="${TIMI_MRI}">Timi Ajiboye</at>`,
    { format: 'html' },
  )

  expect(payload.content).toContain('itemid="0"')
  expect(payload.content).toContain('itemid="1"')
  expect(JSON.parse(payload.properties?.mentions ?? '[]')).toEqual([
    { itemid: 0, mri: GRACE_MRI, mentionType: 'person', displayName: 'Grace Hardy' },
    { itemid: 1, mri: TIMI_MRI, mentionType: 'person', displayName: 'Timi Ajiboye' },
  ])
})

it('normalizes orgid-prefixed at-ids to 8:orgid MRIs', () => {
  const payload = buildChatSendPayload('<at id="orgid:c281778c-e71c-415a-8625-ab1f85b9eda9">Grace Hardy</at>', {
    format: 'html',
  })

  expect(JSON.parse(payload.properties?.mentions ?? '[]')[0].mri).toBe(GRACE_MRI)
})

it('injects extra mentions at @Name when no at-tag is present', () => {
  const payload = buildChatSendPayload('Hey @Timi Ajiboye', {
    format: 'text',
    mentions: [{ mri: TIMI_MRI, displayName: 'Timi Ajiboye' }],
  })

  expect(payload.content).toContain('itemid="0"')
  expect(payload.content).toContain('Timi Ajiboye')
  expect(payload.content).not.toContain('@Timi Ajiboye')
  expect(JSON.parse(payload.properties?.mentions ?? '[]')).toEqual([
    { itemid: 0, mri: TIMI_MRI, mentionType: 'person', displayName: 'Timi Ajiboye' },
  ])
})

it('converts html paragraph breaks to br tags', () => {
  const payload = buildChatSendPayload('one\n\ntwo\n\nthree', { format: 'html' })

  expect(payload.content).toBe('one<br/><br/>two<br/><br/>three')
  expect(payload.properties).toBeUndefined()
})

it('converts text paragraph breaks to br tags after escaping', () => {
  const payload = buildChatSendPayload('a <b>\n\nc & d', { format: 'text' })

  expect(payload.content).toBe('a &lt;b&gt;<br/><br/>c &amp; d')
})

it('keeps a six-paragraph html mention draft spaced', () => {
  const html = [
    `Hey <at id="${GRACE_MRI}">Grace Hardy</at>,`,
    '',
    'Paragraph two.',
    '',
    'Paragraph three.',
    '',
    'Paragraph four.',
    '',
    'Paragraph five.',
    '',
    'Paragraph six.',
  ].join('\n')

  const payload = buildChatSendPayload(html, { format: 'html' })

  expect(payload.content).toContain(
    '<span itemtype="http://schema.skype.com/Mention" itemscope itemid="0">Grace Hardy</span>',
  )
  expect(payload.content.split('<br/><br/>')).toHaveLength(6)
  expect(JSON.parse(payload.properties?.mentions ?? '[]')).toEqual([
    { itemid: 0, mri: GRACE_MRI, mentionType: 'person', displayName: 'Grace Hardy' },
  ])
})

it('does not add properties when there are no mentions', () => {
  const payload = buildChatSendPayload('a <b> & c', { format: 'text' })

  expect(payload).toEqual({
    content: 'a &lt;b&gt; &amp; c',
    messagetype: 'RichText/Html',
    contenttype: 'text',
  })
})

it('leaves markdown paragraph spacing to markdown-to-html', () => {
  const payload = buildChatSendPayload('one\n\ntwo', { format: 'markdown' })

  expect(payload.content).toBe('one<br/><br/>two')
  expect(payload.properties).toBeUndefined()
})

it('preserveRichTextBreaks turns single newlines into br', () => {
  expect(preserveRichTextBreaks('a\nb')).toBe('a<br/>b')
  expect(preserveRichTextBreaks('a\r\n\r\nb')).toBe('a<br/><br/>b')
})
