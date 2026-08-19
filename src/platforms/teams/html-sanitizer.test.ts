import { expect, it } from 'bun:test'

import { sanitizeTeamsHtml } from './html-sanitizer'

it('keeps at-mention tags and their id', () => {
  const html = 'Hey <at id="8:orgid:c281778c-e71c-415a-8625-ab1f85b9eda9">Grace Hardy</at>'
  expect(sanitizeTeamsHtml(html)).toBe(html)
})

it('keeps Skype mention spans and required attrs', () => {
  const html =
    '<span itemtype="http://schema.skype.com/Mention" itemscope itemid="0">Grace Hardy</span>'
  expect(sanitizeTeamsHtml(html)).toBe(html)
})

it('escapes non-mention spans', () => {
  expect(sanitizeTeamsHtml('<span class="x">nope</span>')).toBe('&lt;span class="x"&gt;nope</span>')
})

it('rejects mention spans with a non-skype itemtype', () => {
  const html = '<span itemtype="javascript:alert(1)" itemscope itemid="0">x</span>'
  expect(sanitizeTeamsHtml(html)).toBe('&lt;span itemtype="javascript:alert(1)" itemscope itemid="0"&gt;x</span>')
})

it('keeps br and p tags used for spacing', () => {
  expect(sanitizeTeamsHtml('a<br/>b<p>c</p>')).toBe('a<br>b<p>c</p>')
})
