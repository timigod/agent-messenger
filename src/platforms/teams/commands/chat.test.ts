import { afterEach, beforeEach, expect, mock, spyOn, it } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'

import { TeamsClient } from '../client'
import { TeamsCredentialManager } from '../credential-manager'
import { chatCommand, downloadImageAction, editAction, historyAction, listAction, sendAction, startAction } from './chat'

let clientListChatsSpy: ReturnType<typeof spyOn>
let clientGetChatMessagesSpy: ReturnType<typeof spyOn>
let clientSendChatMessageSpy: ReturnType<typeof spyOn>
let clientStartOneOnOneChatSpy: ReturnType<typeof spyOn>
let clientEditChatMessageSpy: ReturnType<typeof spyOn>
let clientDownloadChatImageSpy: ReturnType<typeof spyOn>
let credManagerLoadSpy: ReturnType<typeof spyOn>
let processExitSpy: ReturnType<typeof spyOn>
const originalConsoleLog = console.log

beforeEach(() => {
  clientListChatsSpy = spyOn(TeamsClient.prototype, 'listChats').mockResolvedValue([
    { id: '19:1on1@unq.gbl.spaces', type: 'oneOnOne', last_message: 'Hi', last_message_at: '2025-01-29T10:00:00Z' },
    { id: '19:group@thread.tacv2', type: 'group', topic: 'Group Chat' },
  ])

  clientGetChatMessagesSpy = spyOn(TeamsClient.prototype, 'getChatMessages').mockResolvedValue([
    {
      id: 'msg_123',
      channel_id: '19:1on1@unq.gbl.spaces',
      author: { id: 'user_789', displayName: 'Alice' },
      content: 'Hello world',
      timestamp: '2025-01-29T10:00:00Z',
    },
  ])

  clientSendChatMessageSpy = spyOn(TeamsClient.prototype, 'sendChatMessage').mockResolvedValue({
    id: '1704067200000',
    channel_id: '19:1on1@unq.gbl.spaces',
    author: { id: 'ME', displayName: 'Me' },
    content: 'Hello world',
    timestamp: '2025-01-29T10:00:00Z',
  })

  clientStartOneOnOneChatSpy = spyOn(TeamsClient.prototype, 'startOneOnOneChat').mockResolvedValue({
    id: '19:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee_11111111-1111-1111-1111-111111111111@unq.gbl.spaces',
    created: true,
    person: '8:orgid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  })

  clientEditChatMessageSpy = spyOn(TeamsClient.prototype, 'editChatMessage').mockResolvedValue({
    id: 'msg_123',
    channel_id: '19:1on1@unq.gbl.spaces',
    author: { id: 'ME', displayName: 'Me' },
    content: 'Edited content',
    timestamp: '2025-01-29T10:05:00Z',
  })
  clientDownloadChatImageSpy = spyOn(TeamsClient.prototype, 'downloadChatImage').mockResolvedValue({
    image_object_id: '0-frca-d16-image',
    content_type: 'image/png',
    extension: 'png',
    size: 8,
    buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  })

  credManagerLoadSpy = spyOn(TeamsCredentialManager.prototype, 'loadConfig').mockResolvedValue({
    current_account: 'personal',
    accounts: {
      personal: {
        token: 'test_token',
        account_type: 'personal' as const,
        current_team: null,
        teams: {},
      },
    },
  })
  processExitSpy = spyOn(process, 'exit').mockImplementation((code?: string | number | null): never => {
    throw new Error(`process.exit:${code ?? 0}`)
  })
})

afterEach(() => {
  clientListChatsSpy?.mockRestore()
  clientGetChatMessagesSpy?.mockRestore()
  clientSendChatMessageSpy?.mockRestore()
  clientStartOneOnOneChatSpy?.mockRestore()
  clientEditChatMessageSpy?.mockRestore()
  clientDownloadChatImageSpy?.mockRestore()
  credManagerLoadSpy?.mockRestore()
  processExitSpy?.mockRestore()
  console.log = originalConsoleLog
  rmSync('/tmp/test-teams-chat-download.png', { force: true })
})

it('list: returns array of chats', async () => {
  const consoleSpy = mock((_msg: string) => {})
  console.log = consoleSpy

  await listAction({ pretty: false })

  expect(consoleSpy).toHaveBeenCalled()
  const output = consoleSpy.mock.calls[0][0]
  expect(output).toContain('19:1on1@unq.gbl.spaces')
  expect(output).toContain('19:group@thread.tacv2')
})

it('history: returns array of messages', async () => {
  const consoleSpy = mock((_msg: string) => {})
  console.log = consoleSpy

  await historyAction('19:1on1@unq.gbl.spaces', { limit: 50, pretty: false })

  expect(consoleSpy).toHaveBeenCalled()
  const output = consoleSpy.mock.calls[0][0]
  expect(output).toContain('msg_123')
  expect(output).toContain('Alice')
  expect(output).toContain('user_789')
})

it('history: falls back to default limit when given a non-positive value', async () => {
  const consoleSpy = mock((_msg: string) => {})
  console.log = consoleSpy

  await historyAction('19:1on1@unq.gbl.spaces', { limit: -5, pretty: false })

  expect(clientGetChatMessagesSpy).toHaveBeenCalledWith('19:1on1@unq.gbl.spaces', 50)
})

it('send: returns sent message', async () => {
  const consoleSpy = mock((_msg: string) => {})
  console.log = consoleSpy

  await sendAction('19:1on1@unq.gbl.spaces', 'Hello world', { pretty: false })

  expect(clientSendChatMessageSpy).toHaveBeenCalledWith('19:1on1@unq.gbl.spaces', 'Hello world', { format: 'text' })
  expect(consoleSpy).toHaveBeenCalled()
  const output = consoleSpy.mock.calls[0][0]
  expect(output).toContain('Hello world')
})

it('send: passes --image through to sendChatMessage', async () => {
  const consoleSpy = mock((_msg: string) => {})
  console.log = consoleSpy
  clientSendChatMessageSpy.mockResolvedValue({
    id: '1704067200000',
    channel_id: '19:1on1@unq.gbl.spaces',
    author: { id: 'ME', displayName: 'Me' },
    content: 'Hello world',
    timestamp: '2025-01-29T10:00:00Z',
    image_object_id: '0-frca-d16-upload',
  })

  await sendAction('19:1on1@unq.gbl.spaces', 'Hello world', {
    pretty: false,
    image: '/tmp/test-teams-chat-image.png',
  })

  expect(clientSendChatMessageSpy).toHaveBeenCalledWith('19:1on1@unq.gbl.spaces', 'Hello world', {
    format: 'text',
    imagePath: '/tmp/test-teams-chat-image.png',
  })
  expect(consoleSpy.mock.calls[0][0]).toContain('0-frca-d16-upload')
})

it('send: --dry-run prints image_path and does not upload or send', async () => {
  const consoleSpy = mock((_msg: string) => {})
  console.log = consoleSpy

  await sendAction('19:1on1@unq.gbl.spaces', 'Hello world', {
    pretty: false,
    image: '/tmp/test-teams-chat-image.png',
    dryRun: true,
  })

  expect(credManagerLoadSpy).not.toHaveBeenCalled()
  expect(clientSendChatMessageSpy).not.toHaveBeenCalled()
  const output = consoleSpy.mock.calls[0][0]
  expect(output).toContain('image_path')
  expect(output).toContain('/tmp/test-teams-chat-image.png')
  expect(output).toContain('dry_run')
  expect(output).toContain('body')
})

it('send: --dry-run of html mention copy shows properties.mentions and br', async () => {
  const consoleSpy = mock((_msg: string) => {})
  console.log = consoleSpy
  const html = [
    'Hey <at id="8:orgid:c281778c-e71c-415a-8625-ab1f85b9eda9">Grace Hardy</at>,',
    '',
    'Paragraph two.',
    '',
    'Paragraph three.',
  ].join('\n')

  await sendAction('19:group@thread.tacv2', html, { pretty: false, format: 'html', dryRun: true })

  expect(clientSendChatMessageSpy).not.toHaveBeenCalled()
  const output = consoleSpy.mock.calls[0][0]
  expect(output).toContain('properties')
  expect(output).toContain('mentions')
  expect(output).toContain('8:orgid:c281778c-e71c-415a-8625-ab1f85b9eda9')
  expect(output).toContain('<br/><br/>')
  expect(output).toContain('itemid')
  expect(output).toContain('schema.skype.com/Mention')
})

it('send: help mentions --image, --dry-run, and --format', () => {
  const send = chatCommand.commands.find((command) => command.name() === 'send')
  const help = send?.helpInformation() ?? ''
  expect(help).toContain('--image')
  expect(help).toContain('--dry-run')
  expect(help).toContain('--format')
})

it('send: passes --format html through to sendChatMessage', async () => {
  const consoleSpy = mock((_msg: string) => {})
  console.log = consoleSpy
  const html = 'Hey <at id="8:orgid:c281778c-e71c-415a-8625-ab1f85b9eda9">Grace Hardy</at>'

  await sendAction('19:group@thread.tacv2', html, { pretty: false, format: 'html' })

  expect(clientSendChatMessageSpy).toHaveBeenCalledWith('19:group@thread.tacv2', html, { format: 'html' })
})

it('send: rejects an invalid --format without sending', async () => {
  const consoleSpy = mock((_msg: string) => {})
  console.log = consoleSpy

  await expect(sendAction('19:1on1@unq.gbl.spaces', 'Hello world', { pretty: false, format: 'rtf' })).rejects.toThrow(
    'process.exit:1',
  )

  expect(clientSendChatMessageSpy).not.toHaveBeenCalled()
  expect(consoleSpy.mock.calls[0][0]).toContain('Invalid format')
})

it('does not register the out-of-scope send-image command', () => {
  expect(chatCommand.commands.map((command) => command.name())).not.toContain('send-image')
})

it('download-image: writes the verified image to the exact output path', async () => {
  const consoleSpy = mock((_msg: string) => {})
  console.log = consoleSpy
  const outputPath = '/tmp/test-teams-chat-download.png'

  await downloadImageAction('0-frca-d16-image', outputPath, { pretty: false })

  expect(clientDownloadChatImageSpy).toHaveBeenCalledWith('0-frca-d16-image')
  expect(existsSync(outputPath)).toBe(true)
  expect(readFileSync(outputPath)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  expect(consoleSpy.mock.calls[0][0]).toContain(outputPath)
})

it('download-image: refuses to replace an existing output file', async () => {
  const outputPath = '/tmp/test-teams-chat-download.png'
  await Bun.write(outputPath, 'keep')

  await expect(downloadImageAction('0-frca-d16-image', outputPath, { pretty: false })).rejects.toThrow('process.exit:1')

  expect(readFileSync(outputPath, 'utf8')).toBe('keep')
})

it('edit: edits a chat message and returns updated content', async () => {
  const consoleSpy = mock((_msg: string) => {})
  console.log = consoleSpy

  await editAction('19:1on1@unq.gbl.spaces', 'msg_123', 'Edited content', { pretty: false })

  expect(clientEditChatMessageSpy).toHaveBeenCalledWith('19:1on1@unq.gbl.spaces', 'msg_123', 'Edited content')
  expect(consoleSpy).toHaveBeenCalled()
  const output = consoleSpy.mock.calls[0][0]
  expect(output).toContain('Edited content')
})

it('start: returns conversation id from startOneOnOneChat', async () => {
  const consoleSpy = mock((_msg: string) => {})
  console.log = consoleSpy

  await startAction('8:orgid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', { pretty: false })

  expect(clientStartOneOnOneChatSpy).toHaveBeenCalledWith('8:orgid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
  const output = consoleSpy.mock.calls[0][0]
  expect(output).toContain('19:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee_11111111-1111-1111-1111-111111111111@unq.gbl.spaces')
  expect(output).toContain('conversation_id')
})

it('start: --dry-run prints the intended person and does not create', async () => {
  const consoleSpy = mock((_msg: string) => {})
  console.log = consoleSpy

  await startAction('orgid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', { pretty: false, dryRun: true })

  expect(credManagerLoadSpy).not.toHaveBeenCalled()
  expect(clientStartOneOnOneChatSpy).not.toHaveBeenCalled()
  const output = consoleSpy.mock.calls[0][0]
  expect(output).toContain('dry_run')
  expect(output).toContain('orgid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
})

it('start: help mentions person and --dry-run', () => {
  const start = chatCommand.commands.find((command) => command.name() === 'start')
  const help = start?.helpInformation() ?? ''
  expect(help).toContain('person')
  expect(help).toContain('--dry-run')
})

it('chat --help lists the start command', () => {
  expect(chatCommand.commands.map((command) => command.name())).toContain('start')
  expect(chatCommand.helpInformation()).toContain('start')
})
