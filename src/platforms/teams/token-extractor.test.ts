import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, spyOn, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { DerivedKeyCache } from '@/shared/utils/derived-key-cache'

import { TeamsTokenExtractor, resolveTeamsTokenSource } from './token-extractor'

describe('TeamsTokenExtractor', () => {
  let extractor: TeamsTokenExtractor

  beforeEach(() => {
    extractor = new TeamsTokenExtractor()
  })

  describe('getDesktopCookiesPaths', () => {
    it('returns darwin desktop paths on macOS', () => {
      const darwinExtractor = new TeamsTokenExtractor('darwin')
      const paths = darwinExtractor.getDesktopCookiesPaths()

      const darwinEbWebView = join(
        homedir(),
        'Library',
        'Containers',
        'com.microsoft.teams2',
        'Data',
        'Library',
        'Application Support',
        'Microsoft',
        'MSTeams',
        'EBWebView',
      )
      expect(paths).toEqual([
        { path: join(darwinEbWebView, 'WV2Profile_tfw', 'Cookies'), accountType: 'work', accountTypeKnown: true },
        {
          path: join(darwinEbWebView, 'WV2Profile_tfw', 'Network', 'Cookies'),
          accountType: 'work',
          accountTypeKnown: true,
        },
        {
          path: join(darwinEbWebView, 'WV2Profile_tfl', 'Cookies'),
          accountType: 'personal',
          accountTypeKnown: true,
        },
        {
          path: join(darwinEbWebView, 'WV2Profile_tfl', 'Network', 'Cookies'),
          accountType: 'personal',
          accountTypeKnown: true,
        },
        { path: join(darwinEbWebView, 'Default', 'Cookies'), accountType: 'work', accountTypeKnown: false },
        { path: join(darwinEbWebView, 'Default', 'Network', 'Cookies'), accountType: 'work', accountTypeKnown: false },
        {
          path: join(homedir(), 'Library', 'Application Support', 'Microsoft', 'Teams', 'Cookies'),
          accountType: 'work',
          accountTypeKnown: false,
        },
      ])
    })

    it('returns linux desktop path on Linux', () => {
      const linuxExtractor = new TeamsTokenExtractor('linux')
      const paths = linuxExtractor.getDesktopCookiesPaths()

      expect(paths).toEqual([
        {
          path: join(homedir(), '.config', 'Microsoft', 'Microsoft Teams', 'Cookies'),
          accountType: 'work',
          accountTypeKnown: false,
        },
      ])
    })

    it('returns win32 desktop paths on Windows', () => {
      const winExtractor = new TeamsTokenExtractor('win32')
      const paths = winExtractor.getDesktopCookiesPaths()

      const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
      const appdata = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
      const winEbWebView = join(
        localAppData,
        'Packages',
        'MSTeams_8wekyb3d8bbwe',
        'LocalCache',
        'Microsoft',
        'MSTeams',
        'EBWebView',
      )
      expect(paths).toEqual([
        { path: join(winEbWebView, 'WV2Profile_tfw', 'Cookies'), accountType: 'work', accountTypeKnown: true },
        {
          path: join(winEbWebView, 'WV2Profile_tfw', 'Network', 'Cookies'),
          accountType: 'work',
          accountTypeKnown: true,
        },
        { path: join(winEbWebView, 'WV2Profile_tfl', 'Cookies'), accountType: 'personal', accountTypeKnown: true },
        {
          path: join(winEbWebView, 'WV2Profile_tfl', 'Network', 'Cookies'),
          accountType: 'personal',
          accountTypeKnown: true,
        },
        { path: join(winEbWebView, 'Default', 'Cookies'), accountType: 'work', accountTypeKnown: false },
        { path: join(winEbWebView, 'Default', 'Network', 'Cookies'), accountType: 'work', accountTypeKnown: false },
        { path: join(appdata, 'Microsoft', 'Teams', 'Cookies'), accountType: 'work', accountTypeKnown: false },
      ])
    })

    it('returns empty array for unsupported platform', () => {
      const unsupportedExtractor = new TeamsTokenExtractor('freebsd' as NodeJS.Platform)
      expect(unsupportedExtractor.getDesktopCookiesPaths()).toEqual([])
    })
  })

  describe('getBrowserCookiesPaths', () => {
    it('returns browser cookie paths on macOS (at least Default profile per browser)', () => {
      const darwinExtractor = new TeamsTokenExtractor('darwin')
      const paths = darwinExtractor.getBrowserCookiesPaths()

      const chromeBase = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
      expect(paths).toContainEqual({
        path: join(chromeBase, 'Default', 'Cookies'),
        accountType: 'work',
        accountTypeKnown: false,
      })
      expect(paths).toContainEqual({
        path: join(chromeBase, 'Default', 'Network', 'Cookies'),
        accountType: 'work',
        accountTypeKnown: false,
      })
    })

    it('returns browser cookie paths on Linux', () => {
      const linuxExtractor = new TeamsTokenExtractor('linux')
      const paths = linuxExtractor.getBrowserCookiesPaths()

      const chromeBase = join(homedir(), '.config', 'google-chrome')
      expect(paths).toContainEqual({
        path: join(chromeBase, 'Default', 'Cookies'),
        accountType: 'work',
        accountTypeKnown: false,
      })
    })

    it('returns browser cookie paths on Windows', () => {
      const winExtractor = new TeamsTokenExtractor('win32')
      const paths = winExtractor.getBrowserCookiesPaths()

      const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
      const chromeBase = join(localAppData, 'Google', 'Chrome', 'User Data')
      expect(paths).toContainEqual({
        path: join(chromeBase, 'Default', 'Cookies'),
        accountType: 'work',
        accountTypeKnown: false,
      })
    })

    it('returns empty array for unsupported platform', () => {
      const unsupportedExtractor = new TeamsTokenExtractor('freebsd' as NodeJS.Platform)
      expect(unsupportedExtractor.getBrowserCookiesPaths()).toEqual([])
    })

    // Regression for #163: browser paths must not assert accountType confidently because
    // Chromium profile paths don't encode work vs personal. Desktop WV2Profile_tfw/_tfl
    // paths are authoritative; browsers must be probed at validation time.
    it('browser paths have accountTypeKnown=false so they get probed at validation', () => {
      const darwinExtractor = new TeamsTokenExtractor('darwin')
      const paths = darwinExtractor.getBrowserCookiesPaths()
      expect(paths.length).toBeGreaterThan(0)
      expect(paths.every((p) => p.accountTypeKnown === false)).toBe(true)
    })
  })

  describe('getTeamsCookiesPaths', () => {
    it('returns darwin paths on macOS with desktop paths first', () => {
      const darwinExtractor = new TeamsTokenExtractor('darwin')
      const paths = darwinExtractor.getTeamsCookiesPaths()
      const desktopPaths = darwinExtractor.getDesktopCookiesPaths()

      expect(paths.slice(0, desktopPaths.length)).toEqual(desktopPaths)
    })

    it('browser paths come after desktop paths on macOS', () => {
      const darwinExtractor = new TeamsTokenExtractor('darwin')
      const paths = darwinExtractor.getTeamsCookiesPaths()
      const desktopPaths = darwinExtractor.getDesktopCookiesPaths()
      const browserPaths = darwinExtractor.getBrowserCookiesPaths()

      expect(paths.length).toBe(desktopPaths.length + browserPaths.length)
      expect(paths.slice(desktopPaths.length)).toEqual(browserPaths)
    })

    it('returns linux paths with desktop first then browser paths', () => {
      const linuxExtractor = new TeamsTokenExtractor('linux')
      const paths = linuxExtractor.getTeamsCookiesPaths()
      const desktopPaths = linuxExtractor.getDesktopCookiesPaths()

      expect(paths.slice(0, 1)).toEqual([
        {
          path: join(homedir(), '.config', 'Microsoft', 'Microsoft Teams', 'Cookies'),
          accountType: 'work',
          accountTypeKnown: false,
        },
      ])
      expect(paths.length).toBeGreaterThan(desktopPaths.length)
    })

    it('returns win32 paths with desktop first then browser paths', () => {
      const winExtractor = new TeamsTokenExtractor('win32')
      const paths = winExtractor.getTeamsCookiesPaths()
      const desktopPaths = winExtractor.getDesktopCookiesPaths()

      expect(paths.slice(0, desktopPaths.length)).toEqual(desktopPaths)
      expect(paths.length).toBeGreaterThan(desktopPaths.length)
    })

    it('returns empty array for unsupported platform', () => {
      const unsupportedExtractor = new TeamsTokenExtractor('freebsd' as NodeJS.Platform)
      const paths = unsupportedExtractor.getTeamsCookiesPaths()

      expect(paths).toEqual([])
    })

    it('returns only official Teams desktop paths in desktop mode', () => {
      const desktopOnly = new TeamsTokenExtractor('darwin', undefined, undefined, undefined, 'desktop')

      expect(desktopOnly.getTeamsCookiesPaths()).toEqual(desktopOnly.getDesktopCookiesPaths())
      expect(desktopOnly.getTeamsCookiesPaths().some((entry) => entry.path.includes('Google/Chrome'))).toBe(false)
    })

    it('can read a companion-staged Teams desktop profile instead of the protected app container', () => {
      const stagedRoot = join(tmpdir(), 'teams-bridge-stage')
      const staged = new TeamsTokenExtractor('darwin', undefined, undefined, undefined, 'desktop', stagedRoot)

      expect(staged.getDesktopCookiesPaths()).toContainEqual({
        path: join(stagedRoot, 'WV2Profile_tfw', 'Network', 'Cookies'),
        accountType: 'work',
        accountTypeKnown: true,
      })
      expect(staged.getLocalStatePath()).toBe(join(stagedRoot, 'Local State'))
    })
  })

  describe('getLocalStatePath', () => {
    it('returns darwin Local State path on macOS', () => {
      const darwinExtractor = new TeamsTokenExtractor('darwin')
      const path = darwinExtractor.getLocalStatePath()

      expect(path).toBe(join(homedir(), 'Library', 'Application Support', 'Microsoft', 'Teams', 'Local State'))
    })

    it('returns linux Local State path on Linux', () => {
      const linuxExtractor = new TeamsTokenExtractor('linux')
      const path = linuxExtractor.getLocalStatePath()

      expect(path).toBe(join(homedir(), '.config', 'Microsoft', 'Microsoft Teams', 'Local State'))
    })

    it('returns win32 Local State path on Windows', () => {
      const winExtractor = new TeamsTokenExtractor('win32')
      const path = winExtractor.getLocalStatePath()

      const appdata = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
      expect(path).toBe(join(appdata, 'Microsoft', 'Teams', 'Local State'))
    })
  })

  describe('getKeychainVariants', () => {
    it('includes Teams-specific keychain entries', () => {
      const macExtractor = new TeamsTokenExtractor('darwin')
      const variants = macExtractor.getKeychainVariants()

      expect(variants).toContainEqual({ service: 'Microsoft Teams Safe Storage', account: 'Microsoft Teams' })
      expect(variants).toContainEqual({
        service: 'Microsoft Teams (work or school) Safe Storage',
        account: 'Microsoft Teams (work or school)',
      })
      expect(variants).toContainEqual({ service: 'Microsoft Edge Safe Storage', account: 'Microsoft Edge' })
      expect(variants).toContainEqual({ service: 'Teams Safe Storage', account: 'Teams' })
    })

    it('includes browser keychain entries appended after Teams entries', () => {
      const macExtractor = new TeamsTokenExtractor('darwin')
      const variants = macExtractor.getKeychainVariants()

      expect(variants).toContainEqual({ service: 'Chrome Safe Storage', account: 'Chrome' })
      expect(variants).toContainEqual({ service: 'Chrome Canary Safe Storage', account: 'Chrome Canary' })
      expect(variants).toContainEqual({ service: 'Arc Safe Storage', account: 'Arc' })
      expect(variants).toContainEqual({ service: 'Brave Safe Storage', account: 'Brave' })
      expect(variants).toContainEqual({ service: 'Vivaldi Safe Storage', account: 'Vivaldi' })
      expect(variants).toContainEqual({ service: 'Chromium Safe Storage', account: 'Chromium' })
    })

    it('Teams entries come before browser entries', () => {
      const macExtractor = new TeamsTokenExtractor('darwin')
      const variants = macExtractor.getKeychainVariants()

      const teamsIdx = variants.findIndex((v) => v.service === 'Microsoft Teams Safe Storage')
      const chromeIdx = variants.findIndex((v) => v.service === 'Chrome Safe Storage')
      expect(teamsIdx).toBeLessThan(chromeIdx)
    })

    it('uses only Teams Keychain entries in desktop mode', () => {
      const desktopOnly = new TeamsTokenExtractor('darwin', undefined, undefined, undefined, 'desktop')
      const variants = desktopOnly.getKeychainVariants()

      expect(variants).toContainEqual({ service: 'Microsoft Teams Safe Storage', account: 'Microsoft Teams' })
      expect(variants.some((variant) => variant.service.includes('Chrome'))).toBe(false)
      expect(variants.some((variant) => variant.service.includes('Edge'))).toBe(false)
    })
  })

  describe('resolveTeamsTokenSource', () => {
    it('defaults to all and accepts desktop', () => {
      expect(resolveTeamsTokenSource()).toBe('all')
      expect(resolveTeamsTokenSource('desktop')).toBe('desktop')
    })

    it('rejects unknown sources', () => {
      expect(() => resolveTeamsTokenSource('browser')).toThrow('Invalid Teams token source')
    })
  })

  describe('isValidSkypeToken', () => {
    it('validates JWT-like skype token format', () => {
      const validToken = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature'
      expect(extractor.isValidSkypeToken(validToken)).toBe(true)
    })

    it('validates long base64 token format', () => {
      const validToken = 'a'.repeat(100)
      expect(extractor.isValidSkypeToken(validToken)).toBe(true)
    })

    it('rejects empty tokens', () => {
      expect(extractor.isValidSkypeToken('')).toBe(false)
    })

    it('rejects short tokens', () => {
      expect(extractor.isValidSkypeToken('short')).toBe(false)
    })

    it('rejects null/undefined', () => {
      expect(extractor.isValidSkypeToken(null as unknown as string)).toBe(false)
      expect(extractor.isValidSkypeToken(undefined as unknown as string)).toBe(false)
    })

    // Regression for #156: PowerShell CLIXML leaks into DPAPI output on Windows.
    it('rejects CLIXML progress-stream contamination', () => {
      // given: the exact shape of the leak reported in #156
      const clixml =
        '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
        '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T>' +
        '<T>System.Object</T></TN><MS><I64 N="SourceId">1</I64></MS></Obj></Objs>'

      // then
      expect(extractor.isValidSkypeToken(clixml)).toBe(false)
    })

    it('rejects anything containing angle brackets or whitespace', () => {
      expect(extractor.isValidSkypeToken('a'.repeat(60) + '<div>')).toBe(false)
      expect(extractor.isValidSkypeToken('a'.repeat(40) + ' ' + 'b'.repeat(40))).toBe(false)
      expect(extractor.isValidSkypeToken('a'.repeat(40) + '\n' + 'b'.repeat(40))).toBe(false)
    })

    it('rejects a bare 36-char UUID', () => {
      expect(extractor.isValidSkypeToken('12345678-1234-1234-1234-123456789012')).toBe(false)
    })
  })

  describe('isEncryptedValue', () => {
    it('detects v10 encrypted values', () => {
      const encrypted = Buffer.from('v10encrypted_data')
      expect(extractor.isEncryptedValue(encrypted)).toBe(true)
    })

    it('detects v11 encrypted values', () => {
      const encrypted = Buffer.from('v11encrypted_data')
      expect(extractor.isEncryptedValue(encrypted)).toBe(true)
    })

    it('rejects non-encrypted values', () => {
      const plain = Buffer.from('plain_text')
      expect(extractor.isEncryptedValue(plain)).toBe(false)
    })

    it('rejects empty buffers', () => {
      const empty = Buffer.alloc(0)
      expect(extractor.isEncryptedValue(empty)).toBe(false)
    })

    it('rejects short buffers', () => {
      const short = Buffer.from('v1')
      expect(extractor.isEncryptedValue(short)).toBe(false)
    })
  })

  describe('extract', () => {
    it('returns null when cookies path does not exist', async () => {
      const linuxExtractor = new TeamsTokenExtractor('linux')
      const extractFromCookiesDBSpy = spyOn(linuxExtractor as any, 'extractFromCookiesDB').mockResolvedValue([])

      const result = await linuxExtractor.extract()
      expect(result).toEqual([])

      extractFromCookiesDBSpy.mockRestore()
    })

    it('extracts token from cookies database when available', async () => {
      const mockToken = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature_here'

      const linuxExtractor = new TeamsTokenExtractor('linux')
      const extractFromCookiesDBSpy = spyOn(linuxExtractor as any, 'extractFromCookiesDB').mockResolvedValue([
        { token: mockToken, accountType: 'work', accountTypeKnown: true },
      ])

      const result = await linuxExtractor.extract()

      expect(result).toHaveLength(1)
      expect(result[0].token).toBe(mockToken)

      extractFromCookiesDBSpy.mockRestore()
    })

    it('returns null when extraction fails', async () => {
      const darwinExtractor = new TeamsTokenExtractor('darwin')
      const extractFromCookiesDBSpy = spyOn(darwinExtractor as any, 'extractFromCookiesDB').mockResolvedValue([])

      const result = await darwinExtractor.extract()
      expect(result).toEqual([])

      extractFromCookiesDBSpy.mockRestore()
    })
  })

  describe('extractFromCookiesDB (Network/Cookies fallback)', () => {
    const mockToken = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature_here'
    let workDir: string

    beforeEach(() => {
      workDir = mkdtempSync(join(tmpdir(), 'teams-extractor-test-'))
    })

    const cleanup = () => rmSync(workDir, { recursive: true, force: true })

    // Regression for #156: if only Network/Cookies exists, missing sibling must not poison accountType.
    it('falls through to Network/Cookies when Cookies is missing', async () => {
      // given: only Network/Cookies exists on disk for WV2Profile_tfl
      const profileDir = join(workDir, 'WV2Profile_tfl')
      const networkDir = join(profileDir, 'Network')
      mkdirSync(networkDir, { recursive: true })
      const cookiesPath = join(profileDir, 'Cookies')
      const networkCookiesPath = join(networkDir, 'Cookies')
      writeFileSync(networkCookiesPath, '')

      const winExtractor = new TeamsTokenExtractor('win32')
      const getPathsSpy = spyOn(winExtractor, 'getTeamsCookiesPaths').mockReturnValue([
        { path: cookiesPath, accountType: 'personal', accountTypeKnown: true },
        { path: networkCookiesPath, accountType: 'personal', accountTypeKnown: true },
      ])
      const tried: string[] = []
      const copyAndExtractSpy = spyOn(winExtractor as any, 'copyAndExtract').mockImplementation(async (...args) => {
        const path = args[0] as string
        tried.push(path)
        return [mockToken]
      })

      // when
      const results = await (winExtractor as any).extractFromCookiesDB()

      // then: the Cookies path was skipped (never passed to copyAndExtract),
      // the Network/Cookies sibling was tried, and the token was returned.
      expect(tried).toEqual([networkCookiesPath])
      expect(results).toEqual([{ token: mockToken, accountType: 'personal', accountTypeKnown: true }])

      getPathsSpy.mockRestore()
      copyAndExtractSpy.mockRestore()
      cleanup()
    })

    // Regression for #156: CLIXML-contaminated decrypt output must not short-circuit
    // the work account, leaving other valid paths unvisited.
    it('does not mark accountType seen when the first path yields CLIXML garbage', async () => {
      // given: first work path returns CLIXML garbage, second work path returns a real token
      const clixmlGarbage =
        '#< CLIXML\r\n<Objs xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
        '<Obj S="progress"><TN><T>Progress</T></TN></Obj></Objs>\r\n' +
        'a'.repeat(80)
      const realToken = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature_here'

      const winExtractor = new TeamsTokenExtractor('win32')
      const firstPath = join(workDir, 'WV2Profile_tfw', 'Cookies')
      const secondPath = join(workDir, 'Default', 'Network', 'Cookies')
      const getPathsSpy = spyOn(winExtractor, 'getTeamsCookiesPaths').mockReturnValue([
        { path: firstPath, accountType: 'work', accountTypeKnown: true },
        { path: secondPath, accountType: 'work', accountTypeKnown: true },
      ])
      mkdirSync(join(workDir, 'WV2Profile_tfw'), { recursive: true })
      mkdirSync(join(workDir, 'Default', 'Network'), { recursive: true })
      writeFileSync(firstPath, '')
      writeFileSync(secondPath, '')

      const copyAndExtractSpy = spyOn(winExtractor as any, 'copyAndExtract')
        .mockResolvedValueOnce([clixmlGarbage])
        .mockResolvedValueOnce([realToken])

      // when
      const results = await (winExtractor as any).extractFromCookiesDB()

      // then: garbage was rejected, loop continued to the real token
      expect(copyAndExtractSpy).toHaveBeenCalledTimes(2)
      expect(results).toEqual([{ token: realToken, accountType: 'work', accountTypeKnown: true }])

      getPathsSpy.mockRestore()
      copyAndExtractSpy.mockRestore()
      cleanup()
    })

    // Regression for #163: browser-sourced tokens carry accountTypeKnown=false so that
    // the auth command can probe both endpoints. The extraction loop must preserve the
    // flag and must not dedupe an unknown-type browser token by its guessed accountType.
    it('propagates accountTypeKnown=false for browser-sourced tokens', async () => {
      // given: a browser Cookies path returning a valid token, guessed as work
      const browserPath = join(workDir, 'Chrome', 'Default', 'Cookies')
      mkdirSync(join(workDir, 'Chrome', 'Default'), { recursive: true })
      writeFileSync(browserPath, '')

      const winExtractor = new TeamsTokenExtractor('win32')
      const getPathsSpy = spyOn(winExtractor, 'getTeamsCookiesPaths').mockReturnValue([
        { path: browserPath, accountType: 'work', accountTypeKnown: false },
      ])
      const copyAndExtractSpy = spyOn(winExtractor as any, 'copyAndExtract').mockResolvedValue([mockToken])

      // when
      const results = await (winExtractor as any).extractFromCookiesDB()

      // then: the flag is passed through so callers can probe
      expect(results).toEqual([{ token: mockToken, accountType: 'work', accountTypeKnown: false }])

      getPathsSpy.mockRestore()
      copyAndExtractSpy.mockRestore()
      cleanup()
    })

    // Regression for #163: when a desktop path (known=true) for 'work' already succeeded,
    // a subsequent browser path (known=false) guessed as 'work' must still be explored —
    // it might be a personal account misguessed as work. The dedup only kicks in for
    // confidently labeled paths.
    it('does not skip unknown-type path just because a known-type same-label succeeded', async () => {
      const desktopPath = join(workDir, 'WV2Profile_tfw', 'Network', 'Cookies')
      const browserPath = join(workDir, 'Chrome', 'Default', 'Cookies')
      mkdirSync(join(workDir, 'WV2Profile_tfw', 'Network'), { recursive: true })
      mkdirSync(join(workDir, 'Chrome', 'Default'), { recursive: true })
      writeFileSync(desktopPath, '')
      writeFileSync(browserPath, '')

      const desktopToken = mockToken
      const browserToken = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJicm93c2VyIn0.different_signature_here_abc'

      const winExtractor = new TeamsTokenExtractor('win32')
      const getPathsSpy = spyOn(winExtractor, 'getTeamsCookiesPaths').mockReturnValue([
        { path: desktopPath, accountType: 'work', accountTypeKnown: true },
        { path: browserPath, accountType: 'work', accountTypeKnown: false },
      ])
      const copyAndExtractSpy = spyOn(winExtractor as any, 'copyAndExtract')
        .mockResolvedValueOnce([desktopToken])
        .mockResolvedValueOnce([browserToken])

      // when
      const results = await (winExtractor as any).extractFromCookiesDB()

      // then: both tokens returned; browser token keeps accountTypeKnown=false for probing
      expect(results).toEqual([
        { token: desktopToken, accountType: 'work', accountTypeKnown: true },
        { token: browserToken, accountType: 'work', accountTypeKnown: false },
      ])

      getPathsSpy.mockRestore()
      copyAndExtractSpy.mockRestore()
      cleanup()
    })

    it('dedupes identical tokens extracted from multiple paths', async () => {
      const path1 = join(workDir, 'Chrome', 'Default', 'Cookies')
      const path2 = join(workDir, 'Edge', 'Default', 'Cookies')
      mkdirSync(join(workDir, 'Chrome', 'Default'), { recursive: true })
      mkdirSync(join(workDir, 'Edge', 'Default'), { recursive: true })
      writeFileSync(path1, '')
      writeFileSync(path2, '')

      const winExtractor = new TeamsTokenExtractor('win32')
      const getPathsSpy = spyOn(winExtractor, 'getTeamsCookiesPaths').mockReturnValue([
        { path: path1, accountType: 'work', accountTypeKnown: false },
        { path: path2, accountType: 'work', accountTypeKnown: false },
      ])
      const copyAndExtractSpy = spyOn(winExtractor as any, 'copyAndExtract').mockResolvedValue([mockToken])

      // when
      const results = await (winExtractor as any).extractFromCookiesDB()

      // then: only one result despite two paths returning the same token
      expect(results).toHaveLength(1)
      expect(results[0].token).toBe(mockToken)

      getPathsSpy.mockRestore()
      copyAndExtractSpy.mockRestore()
      cleanup()
    })

    it('preserves known personal and work labels when the same candidate appears in both profiles', async () => {
      const workPath = join(workDir, 'WV2Profile_tfw', 'Network', 'Cookies')
      const personalPath = join(workDir, 'WV2Profile_tfl', 'Network', 'Cookies')
      mkdirSync(join(workDir, 'WV2Profile_tfw', 'Network'), { recursive: true })
      mkdirSync(join(workDir, 'WV2Profile_tfl', 'Network'), { recursive: true })
      writeFileSync(workPath, '')
      writeFileSync(personalPath, '')

      const desktopExtractor = new TeamsTokenExtractor('darwin')
      const getPathsSpy = spyOn(desktopExtractor, 'getTeamsCookiesPaths').mockReturnValue([
        { path: workPath, accountType: 'work', accountTypeKnown: true },
        { path: personalPath, accountType: 'personal', accountTypeKnown: true },
      ])
      const copyAndExtractSpy = spyOn(desktopExtractor as any, 'copyAndExtract').mockResolvedValue([mockToken])

      const results = await (desktopExtractor as any).extractFromCookiesDB()

      expect(results).toEqual([
        { token: mockToken, accountType: 'work', accountTypeKnown: true },
        { token: mockToken, accountType: 'personal', accountTypeKnown: true },
      ])

      getPathsSpy.mockRestore()
      copyAndExtractSpy.mockRestore()
      cleanup()
    })

    it('a missing path does not mark the account type as seen', async () => {
      // given: work account has Cookies missing but Network/Cookies present
      const workProfile = join(workDir, 'WV2Profile_tfw')
      const workNetworkDir = join(workProfile, 'Network')
      mkdirSync(workNetworkDir, { recursive: true })
      const workCookies = join(workProfile, 'Cookies')
      const workNetworkCookies = join(workNetworkDir, 'Cookies')
      writeFileSync(workNetworkCookies, '')

      const winExtractor = new TeamsTokenExtractor('win32')
      const getPathsSpy = spyOn(winExtractor, 'getTeamsCookiesPaths').mockReturnValue([
        { path: workCookies, accountType: 'work', accountTypeKnown: true },
        { path: workNetworkCookies, accountType: 'work', accountTypeKnown: true },
      ])
      const copyAndExtractSpy = spyOn(winExtractor as any, 'copyAndExtract').mockResolvedValue([mockToken])

      // when
      const results = await (winExtractor as any).extractFromCookiesDB()

      // then: missing first path did not block the sibling; work token extracted
      expect(results).toHaveLength(1)
      expect(results[0].accountType).toBe('work')
      expect(copyAndExtractSpy).toHaveBeenCalledTimes(1)
      expect(copyAndExtractSpy).toHaveBeenCalledWith(workNetworkCookies)

      getPathsSpy.mockRestore()
      copyAndExtractSpy.mockRestore()
      cleanup()
    })
  })

  describe('copyAndExtract', () => {
    it('attempts to copy database to temp location', async () => {
      const darwinExtractor = new TeamsTokenExtractor('darwin')

      const copyFileSpy = spyOn(darwinExtractor as any, 'copyDatabaseToTemp').mockReturnValue('/tmp/test-cookies')
      const extractSpy = spyOn(darwinExtractor as any, 'extractFromSQLite').mockResolvedValue(['test_token'])
      const cleanupSpy = spyOn(darwinExtractor as any, 'cleanupTempFile').mockImplementation(() => {})

      const result = await (darwinExtractor as any).copyAndExtract('/path/to/Cookies')

      expect(copyFileSpy).toHaveBeenCalled()
      expect(extractSpy).toHaveBeenCalled()
      expect(cleanupSpy).toHaveBeenCalled()
      expect(result).toEqual(['test_token'])

      copyFileSpy.mockRestore()
      extractSpy.mockRestore()
      cleanupSpy.mockRestore()
    })

    it('returns no candidates when copy fails (file locked)', async () => {
      const darwinExtractor = new TeamsTokenExtractor('darwin')

      const copyFileSpy = spyOn(darwinExtractor as any, 'copyDatabaseToTemp').mockImplementation(() => {
        throw new Error('EBUSY: resource busy or locked')
      })

      const result = await (darwinExtractor as any).copyAndExtract('/path/to/Cookies')

      expect(result).toEqual([])

      copyFileSpy.mockRestore()
    })
  })

  describe('decryption', () => {
    describe('decryptAESGCM', () => {
      it('returns null for invalid encrypted data', () => {
        const darwinExtractor = new TeamsTokenExtractor('darwin')
        const invalidData = Buffer.from('too_short')
        const key = Buffer.alloc(32, 0)

        const result = (darwinExtractor as any).decryptAESGCM(invalidData, key)
        expect(result).toBeNull()
      })

      it('returns null when decryption fails', () => {
        const darwinExtractor = new TeamsTokenExtractor('darwin')
        const fakeEncrypted = Buffer.concat([
          Buffer.from('v10'),
          Buffer.alloc(12, 1),
          Buffer.alloc(20, 2),
          Buffer.alloc(16, 3),
        ])
        const key = Buffer.alloc(32, 0)

        const result = (darwinExtractor as any).decryptAESGCM(fakeEncrypted, key)
        expect(result).toBeNull()
      })
    })

    describe('getKeychainPassword (macOS)', () => {
      it('tries multiple keychain variants', async () => {
        const darwinExtractor = new TeamsTokenExtractor('darwin')
        const execSyncSpy = spyOn(darwinExtractor as any, 'execSecurityCommand')
          .mockReturnValueOnce(null)
          .mockReturnValueOnce('test_password')

        const result = (darwinExtractor as any).getKeychainPassword()

        expect(execSyncSpy).toHaveBeenCalledTimes(2)
        expect(result).toBe('test_password')

        execSyncSpy.mockRestore()
      })

      it('returns null when all keychain variants fail', async () => {
        const darwinExtractor = new TeamsTokenExtractor('darwin')
        const execSyncSpy = spyOn(darwinExtractor as any, 'execSecurityCommand').mockReturnValue(null)

        const result = (darwinExtractor as any).getKeychainPassword()

        expect(result).toBeNull()

        execSyncSpy.mockRestore()
      })
    })
  })

  describe('process management', () => {
    describe('isTeamsRunning', () => {
      it('returns true when Teams process is found', async () => {
        const darwinExtractor = new TeamsTokenExtractor('darwin')
        const checkProcessRunningSpy = spyOn(darwinExtractor as any, 'checkProcessRunning').mockReturnValue(true)

        const result = await darwinExtractor.isTeamsRunning()
        expect(result).toBe(true)

        checkProcessRunningSpy.mockRestore()
      })

      it('returns false when no Teams process is found', async () => {
        const darwinExtractor = new TeamsTokenExtractor('darwin')
        const checkProcessRunningSpy = spyOn(darwinExtractor as any, 'checkProcessRunning').mockReturnValue(false)

        const result = await darwinExtractor.isTeamsRunning()
        expect(result).toBe(false)

        checkProcessRunningSpy.mockRestore()
      })
    })

    describe('getProcessName', () => {
      it('returns correct process name for macOS', () => {
        const darwinExtractor = new TeamsTokenExtractor('darwin')
        expect((darwinExtractor as any).getProcessName()).toBe('Microsoft Teams')
      })

      it('returns correct process name for Windows', () => {
        const winExtractor = new TeamsTokenExtractor('win32')
        expect((winExtractor as any).getProcessName()).toBe('Teams.exe')
      })

      it('returns correct process name for Linux', () => {
        const linuxExtractor = new TeamsTokenExtractor('linux')
        expect((linuxExtractor as any).getProcessName()).toBe('teams')
      })
    })
  })

  describe('SQLite extraction', () => {
    it('selects a newer teams.microsoft.com authtoken over an older teams.live.com row', async () => {
      const root = mkdtempSync(join(tmpdir(), 'teams-authtoken-host-order-'))
      const dbPath = join(root, 'WV2Profile_tfl', 'Cookies')
      mkdirSync(join(root, 'WV2Profile_tfl'), { recursive: true })
      const db = new Database(dbPath)
      db.exec(
        'CREATE TABLE cookies (name TEXT, value TEXT, encrypted_value BLOB, host_key TEXT, last_access_utc INTEGER)',
      )
      const insert = db.prepare(
        'INSERT INTO cookies (name, value, encrypted_value, host_key, last_access_utc) VALUES (?, ?, ?, ?, ?)',
      )
      insert.run('authtoken', `Bearer=${'old'.repeat(20)}`, Buffer.alloc(0), 'teams.live.com', 100)
      insert.run('authtoken', `Bearer=${'new'.repeat(20)}`, Buffer.alloc(0), 'teams.microsoft.com', 200)
      db.close()

      const token = await new TeamsTokenExtractor(
        'darwin',
        new DerivedKeyCache(join(root, 'key-cache')),
        undefined,
        undefined,
        'desktop',
        root,
      ).extractIdToken('personal')

      expect(token).toBe('new'.repeat(20))
      rmSync(root, { recursive: true, force: true })
    })

    it('selects a newer Network/Cookies authtoken over an older Cookies database row', async () => {
      const root = mkdtempSync(join(tmpdir(), 'teams-authtoken-database-order-'))
      const profileRoot = join(root, 'WV2Profile_tfl')
      mkdirSync(join(profileRoot, 'Network'), { recursive: true })
      for (const [dbPath, token, lastAccessUtc] of [
        [join(profileRoot, 'Cookies'), 'old'.repeat(20), 13_000_000_000_000_000n],
        [join(profileRoot, 'Network', 'Cookies'), 'new'.repeat(20), 13_000_000_000_000_001n],
      ] as const) {
        const db = new Database(dbPath)
        db.exec(
          'CREATE TABLE cookies (name TEXT, value TEXT, encrypted_value BLOB, host_key TEXT, last_access_utc INTEGER)',
        )
        db.prepare(
          'INSERT INTO cookies (name, value, encrypted_value, host_key, last_access_utc) VALUES (?, ?, ?, ?, ?)',
        ).run('authtoken', `Bearer=${token}`, Buffer.alloc(0), 'teams.live.com', lastAccessUtc)
        db.close()
      }

      const token = await new TeamsTokenExtractor(
        'darwin',
        new DerivedKeyCache(join(root, 'key-cache')),
        undefined,
        undefined,
        'desktop',
        root,
      ).extractIdToken('personal')

      expect(token).toBe('new'.repeat(20))
      rmSync(root, { recursive: true, force: true })
    })

    it('does not let a newer known work profile authtoken override a requested personal account', async () => {
      const root = mkdtempSync(join(tmpdir(), 'teams-authtoken-account-filter-'))
      const workProfile = join(root, 'WV2Profile_tfw')
      const personalProfile = join(root, 'WV2Profile_tfl')
      mkdirSync(workProfile, { recursive: true })
      mkdirSync(personalProfile, { recursive: true })
      for (const [dbPath, token, lastAccessUtc] of [
        [join(workProfile, 'Cookies'), 'work'.repeat(20), 300],
        [join(personalProfile, 'Cookies'), 'personal'.repeat(10), 200],
      ] as const) {
        const db = new Database(dbPath)
        db.exec(
          'CREATE TABLE cookies (name TEXT, value TEXT, encrypted_value BLOB, host_key TEXT, last_access_utc INTEGER)',
        )
        db.prepare(
          'INSERT INTO cookies (name, value, encrypted_value, host_key, last_access_utc) VALUES (?, ?, ?, ?, ?)',
        ).run('authtoken', `Bearer=${token}`, Buffer.alloc(0), 'teams.live.com', lastAccessUtc)
        db.close()
      }

      const token = await new TeamsTokenExtractor(
        'darwin',
        new DerivedKeyCache(join(root, 'key-cache')),
        undefined,
        undefined,
        'desktop',
        root,
      ).extractIdToken('personal')

      expect(token).toBe('personal'.repeat(10))
      rmSync(root, { recursive: true, force: true })
    })

    it('skips malformed authtokens and uses stable non-secret tie-breaking', async () => {
      const root = mkdtempSync(join(tmpdir(), 'teams-authtoken-tie-'))
      const dbPath = join(root, 'Cookies')
      const db = new Database(dbPath)
      db.exec(
        'CREATE TABLE cookies (name TEXT, value TEXT, encrypted_value BLOB, host_key TEXT, last_access_utc INTEGER)',
      )
      const insert = db.prepare(
        'INSERT INTO cookies (name, value, encrypted_value, host_key, last_access_utc) VALUES (?, ?, ?, ?, ?)',
      )
      insert.run('authtoken', 'Bearer=%E0%A4%A', Buffer.alloc(0), 'teams.live.com', 300)
      insert.run('authtoken', `Bearer=${'live'.repeat(20)}`, Buffer.alloc(0), 'teams.live.com', 200)
      insert.run('authtoken', `Bearer=${'microsoft'.repeat(10)}`, Buffer.alloc(0), 'teams.microsoft.com', 200)
      db.close()

      const candidates = await (new TeamsTokenExtractor('darwin') as any).extractAuthTokenFromSQLite(dbPath)

      expect(candidates.map((candidate: { bearer: string }) => candidate.bearer)).toEqual([
        'live'.repeat(20),
        'microsoft'.repeat(10),
      ])
      rmSync(root, { recursive: true, force: true })
    })

    it('bounds authtoken candidates and keeps diagnostics secret-free', async () => {
      const root = mkdtempSync(join(tmpdir(), 'teams-authtoken-bound-'))
      const dbPath = join(root, 'Cookies')
      const db = new Database(dbPath)
      db.exec(
        'CREATE TABLE cookies (name TEXT, value TEXT, encrypted_value BLOB, host_key TEXT, last_access_utc INTEGER)',
      )
      const insert = db.prepare(
        'INSERT INTO cookies (name, value, encrypted_value, host_key, last_access_utc) VALUES (?, ?, ?, ?, ?)',
      )
      for (let index = 0; index < 10; index += 1) {
        insert.run(
          'authtoken',
          `Bearer=candidate_${String(index).padStart(2, '0')}_${'x'.repeat(40)}`,
          Buffer.alloc(0),
          index % 2 === 0 ? 'teams.live.com' : 'teams.microsoft.com',
          1_000 - index,
        )
      }
      db.close()

      const debugLines: string[] = []
      const candidates = await (
        new TeamsTokenExtractor('darwin', undefined, (line) => debugLines.push(line)) as any
      ).extractAuthTokenFromSQLite(dbPath)

      expect(candidates).toHaveLength(8)
      expect(debugLines).toContain('    authtoken candidate limit reached; inspecting newest 8 rows')
      expect(debugLines.join('\n')).not.toContain('candidate_')
      rmSync(root, { recursive: true, force: true })
    })

    it('returns same-profile candidates newest-first so API validation can reject a stale row', async () => {
      const root = mkdtempSync(join(tmpdir(), 'teams-cookie-candidates-'))
      const dbPath = join(root, 'Cookies')
      const staleToken = `stale_${'a'.repeat(70)}`
      const currentToken = `current_${'b'.repeat(70)}`
      const db = new Database(dbPath)
      db.exec(
        'CREATE TABLE cookies (name TEXT, value TEXT, encrypted_value BLOB, host_key TEXT, last_access_utc INTEGER)',
      )
      const insert = db.prepare(
        'INSERT INTO cookies (name, value, encrypted_value, host_key, last_access_utc) VALUES (?, ?, ?, ?, ?)',
      )
      insert.run('skypetoken_asm', staleToken, Buffer.alloc(0), '.asm.skype.com', 100)
      insert.run('skypetoken_asm', currentToken, Buffer.alloc(0), '.asm.skype.com', 200)
      db.close()

      const debugLines: string[] = []
      const candidateExtractor = new TeamsTokenExtractor('darwin', undefined, (line) => debugLines.push(line))
      const candidates = await (candidateExtractor as any).extractFromSQLite(dbPath)

      expect(candidates).toEqual([currentToken, staleToken])
      expect(debugLines.join('\n')).not.toContain(currentToken)
      expect(debugLines.join('\n')).not.toContain(staleToken)
      rmSync(root, { recursive: true, force: true })
    })

    it('rejects malformed nearby rows and bounds the candidate set', async () => {
      const root = mkdtempSync(join(tmpdir(), 'teams-cookie-bound-'))
      const dbPath = join(root, 'Cookies')
      const db = new Database(dbPath)
      db.exec(
        'CREATE TABLE cookies (name TEXT, value TEXT, encrypted_value BLOB, host_key TEXT, last_access_utc INTEGER)',
      )
      const insert = db.prepare(
        'INSERT INTO cookies (name, value, encrypted_value, host_key, last_access_utc) VALUES (?, ?, ?, ?, ?)',
      )
      insert.run('skypetoken_asm', `malformed ${'x'.repeat(70)}`, Buffer.alloc(0), '.asm.skype.com', 1_000)
      for (let index = 0; index < 9; index += 1) {
        insert.run(
          'skypetoken_asm',
          `candidate_${String(index).padStart(2, '0')}_${'c'.repeat(60)}`,
          Buffer.alloc(0),
          '.asm.skype.com',
          900 - index,
        )
      }
      db.close()

      const candidates = await (new TeamsTokenExtractor('darwin') as any).extractFromSQLite(dbPath)

      expect(candidates).toHaveLength(7)
      expect(candidates[0]).toStartWith('candidate_00_')
      expect(candidates.at(-1)).toStartWith('candidate_06_')
      expect(candidates.some((candidate: string) => candidate.includes('malformed'))).toBe(false)
      rmSync(root, { recursive: true, force: true })
    })

    it('returns no candidates when database path does not exist', async () => {
      const darwinExtractor = new TeamsTokenExtractor('darwin')

      const result = await (darwinExtractor as any).extractFromSQLite('/nonexistent/path')

      expect(result).toEqual([])
    })

    it('returns no candidates when extraction throws', async () => {
      const darwinExtractor = new TeamsTokenExtractor('darwin')

      const result = await (darwinExtractor as any).extractFromSQLite('/dev/null')

      expect(result).toEqual([])
    })
  })
})
