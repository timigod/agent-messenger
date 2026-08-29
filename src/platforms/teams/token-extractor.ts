import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  BROWSER_KEYCHAIN_VARIANTS,
  CHROMIUM_BROWSERS,
  ChromiumCookieDecryptor,
  ChromiumCookieReader,
  discoverBrowserProfileDirs,
  findLocalStatePath,
  getBrowserBasePath,
  getAgentBrowserProfileDirs,
} from '@/shared/chromium'
import type { KeychainVariant } from '@/shared/chromium'
import { DerivedKeyCache } from '@/shared/utils/derived-key-cache'

import type { TeamsAccountType } from './types'

export interface ExtractedTeamsToken {
  token: string
  accountType: TeamsAccountType
  // False when the account type was guessed from the cookie path and needs to be
  // confirmed against the Teams API (e.g. browser profiles, which don't encode
  // work vs personal in the path). True for desktop paths that reliably encode
  // the account type (WV2Profile_tfw vs WV2Profile_tfl).
  accountTypeKnown: boolean
}

export type TeamsTokenSource = 'all' | 'desktop'

export const TEAMS_CACHED_KEY_REJECTED = 'AGENT_TEAMS_CACHED_KEY_REJECTED'

export class TeamsCachedKeyRejectedError extends Error {
  constructor() {
    super(`${TEAMS_CACHED_KEY_REJECTED}: the cached Teams desktop decryption key no longer matches`)
    this.name = 'TeamsCachedKeyRejectedError'
  }
}

export function resolveTeamsTokenSource(value?: string): TeamsTokenSource {
  if (!value || value === 'all') return 'all'
  if (value === 'desktop') return 'desktop'
  throw new Error(`Invalid Teams token source: ${value}. Use "all" or "desktop".`)
}

interface TeamsCookiePath {
  path: string
  accountType: TeamsAccountType
  accountTypeKnown: boolean
}

interface AuthTokenCandidate {
  bearer: string
  lastAccessUtc: bigint
}

const TEAMS_PROCESS_NAMES: Record<string, string> = {
  darwin: 'Microsoft Teams',
  win32: 'Teams.exe',
  linux: 'teams',
}

const SKYPETOKEN_COOKIE_NAME = 'skypetoken_asm'
// Teams can retain multiple partitioned or superseded rows for the same cookie.
// Keep the candidate set bounded while allowing API validation to reject a stale
// row and continue to a fresher session from the same desktop profile.
const MAX_SKYPE_TOKEN_CANDIDATES_PER_DATABASE = 8
const TEAMS_HOST_PATTERNS = [
  '.asyncgw.teams.microsoft.com',
  '.asm.skype.com',
  'teams.microsoft.com',
  'teams.live.com',
  '.microsoft.com',
]

// The trouter real-time WebSocket needs an OAuth Bearer token (a JWE) for its
// user.authenticate step. Teams stores it in the `authtoken` cookie, prefixed
// with "Bearer=" and URL-encoded.
const AUTHTOKEN_COOKIE_NAME = 'authtoken'
const AUTHTOKEN_HOST_PATTERNS = ['teams.live.com', 'teams.microsoft.com']
// Bound malformed, duplicate, or superseded rows without allowing token bytes
// to participate in ordering or tie-breaking.
const MAX_AUTHTOKEN_ROWS_PER_DATABASE = 8

const TEAMS_KEYCHAIN_VARIANTS: KeychainVariant[] = [
  { service: 'Microsoft Teams Safe Storage', account: 'Microsoft Teams' },
  {
    service: 'Microsoft Teams (work or school) Safe Storage',
    account: 'Microsoft Teams (work or school)',
  },
  { service: 'Teams Safe Storage', account: 'Teams' },
]

export class TeamsTokenExtractor {
  private platform: NodeJS.Platform
  private decryptor: ChromiumCookieDecryptor
  private cookieReader: ChromiumCookieReader
  private debugLog: ((message: string) => void) | null
  private customBrowserProfileDirs: string[]
  private tokenSource: TeamsTokenSource
  private desktopProfileRoot: string | null

  constructor(
    platform?: NodeJS.Platform,
    keyCache?: DerivedKeyCache,
    debugLog?: (message: string) => void,
    customBrowserProfileDirs?: string[],
    tokenSource: TeamsTokenSource = 'all',
    desktopProfileRoot?: string,
  ) {
    this.platform = platform ?? process.platform
    this.debugLog = debugLog ?? null
    this.customBrowserProfileDirs = customBrowserProfileDirs ?? []
    this.tokenSource = tokenSource
    this.desktopProfileRoot = desktopProfileRoot ?? process.env.AGENT_TEAMS_DESKTOP_PROFILE_ROOT ?? null

    const resolvedKeyCache = keyCache ?? new DerivedKeyCache()
    this.decryptor = new ChromiumCookieDecryptor({
      platform: this.platform,
      appKeychainVariants: TEAMS_KEYCHAIN_VARIANTS,
      includeBrowserKeychainVariants: tokenSource !== 'desktop',
      // macOS Teams credentials are application-mediated in this fork. The
      // signed companion supplies a derived key; the library never shells out
      // to `security`, even if somebody bypasses the guarded dispatcher.
      allowKeychainLookup: this.platform !== 'darwin' && process.env.AGENT_TEAMS_DISABLE_KEYCHAIN_LOOKUP !== '1',
      keyCache: resolvedKeyCache,
      keyCachePlatform: 'teams',
    })
    this.cookieReader = new ChromiumCookieReader()
  }

  private debug(message: string): void {
    this.debugLog?.(message)
  }

  getDesktopCookiesPaths(): TeamsCookiePath[] {
    switch (this.platform) {
      case 'darwin': {
        const ebWebViewBase =
          this.desktopProfileRoot ??
          join(
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
        return [
          { path: join(ebWebViewBase, 'WV2Profile_tfw', 'Cookies'), accountType: 'work', accountTypeKnown: true },
          {
            path: join(ebWebViewBase, 'WV2Profile_tfw', 'Network', 'Cookies'),
            accountType: 'work',
            accountTypeKnown: true,
          },
          {
            path: join(ebWebViewBase, 'WV2Profile_tfl', 'Cookies'),
            accountType: 'personal',
            accountTypeKnown: true,
          },
          {
            path: join(ebWebViewBase, 'WV2Profile_tfl', 'Network', 'Cookies'),
            accountType: 'personal',
            accountTypeKnown: true,
          },
          { path: join(ebWebViewBase, 'Default', 'Cookies'), accountType: 'work', accountTypeKnown: false },
          { path: join(ebWebViewBase, 'Default', 'Network', 'Cookies'), accountType: 'work', accountTypeKnown: false },
          {
            path: join(homedir(), 'Library', 'Application Support', 'Microsoft', 'Teams', 'Cookies'),
            accountType: 'work',
            accountTypeKnown: false,
          },
        ]
      }
      case 'linux':
        return [
          {
            path: join(homedir(), '.config', 'Microsoft', 'Microsoft Teams', 'Cookies'),
            accountType: 'work',
            accountTypeKnown: false,
          },
        ]
      case 'win32': {
        const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
        const appdata = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
        const ebWebViewBase = join(
          localAppData,
          'Packages',
          'MSTeams_8wekyb3d8bbwe',
          'LocalCache',
          'Microsoft',
          'MSTeams',
          'EBWebView',
        )
        return [
          { path: join(ebWebViewBase, 'WV2Profile_tfw', 'Cookies'), accountType: 'work', accountTypeKnown: true },
          {
            path: join(ebWebViewBase, 'WV2Profile_tfw', 'Network', 'Cookies'),
            accountType: 'work',
            accountTypeKnown: true,
          },
          {
            path: join(ebWebViewBase, 'WV2Profile_tfl', 'Cookies'),
            accountType: 'personal',
            accountTypeKnown: true,
          },
          {
            path: join(ebWebViewBase, 'WV2Profile_tfl', 'Network', 'Cookies'),
            accountType: 'personal',
            accountTypeKnown: true,
          },
          { path: join(ebWebViewBase, 'Default', 'Cookies'), accountType: 'work', accountTypeKnown: false },
          { path: join(ebWebViewBase, 'Default', 'Network', 'Cookies'), accountType: 'work', accountTypeKnown: false },
          { path: join(appdata, 'Microsoft', 'Teams', 'Cookies'), accountType: 'work', accountTypeKnown: false },
        ]
      }
      default:
        return []
    }
  }

  getBrowserCookiesPaths(): TeamsCookiePath[] {
    const paths: TeamsCookiePath[] = []

    for (const browser of CHROMIUM_BROWSERS) {
      const browserBase = getBrowserBasePath(browser, this.platform)
      if (!browserBase) continue

      for (const profileDir of discoverBrowserProfileDirs(browserBase)) {
        paths.push({ path: join(profileDir, 'Cookies'), accountType: 'work', accountTypeKnown: false })
        paths.push({ path: join(profileDir, 'Network', 'Cookies'), accountType: 'work', accountTypeKnown: false })
      }
    }

    for (const profileDir of getAgentBrowserProfileDirs({ customProfileDirs: this.customBrowserProfileDirs })) {
      paths.push({ path: join(profileDir, 'Cookies'), accountType: 'work', accountTypeKnown: false })
      paths.push({ path: join(profileDir, 'Network', 'Cookies'), accountType: 'work', accountTypeKnown: false })
    }

    return paths
  }

  getTeamsCookiesPaths(): TeamsCookiePath[] {
    const desktopPaths = this.getDesktopCookiesPaths()
    return this.tokenSource === 'desktop' ? desktopPaths : [...desktopPaths, ...this.getBrowserCookiesPaths()]
  }

  getLocalStatePath(): string {
    switch (this.platform) {
      case 'darwin':
        return this.desktopProfileRoot
          ? join(this.desktopProfileRoot, 'Local State')
          : join(homedir(), 'Library', 'Application Support', 'Microsoft', 'Teams', 'Local State')
      case 'linux':
        return join(homedir(), '.config', 'Microsoft', 'Microsoft Teams', 'Local State')
      case 'win32': {
        const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
        const appdata = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
        const newTeamsPath = join(
          localAppData,
          'Packages',
          'MSTeams_8wekyb3d8bbwe',
          'LocalCache',
          'Microsoft',
          'MSTeams',
          'EBWebView',
          'Local State',
        )
        if (existsSync(newTeamsPath)) return newTeamsPath
        return join(appdata, 'Microsoft', 'Teams', 'Local State')
      }
      default:
        return ''
    }
  }

  getKeychainVariants(): KeychainVariant[] {
    return this.tokenSource === 'desktop'
      ? [...TEAMS_KEYCHAIN_VARIANTS]
      : [...TEAMS_KEYCHAIN_VARIANTS, ...BROWSER_KEYCHAIN_VARIANTS]
  }

  isValidSkypeToken(token: string): boolean {
    if (!token || token.length < 50) return false
    // Real skype tokens are JWT-shaped or long base64url-ish strings. Reject anything
    // containing XML/CLIXML artifacts (e.g. leaked PowerShell progress stream) or
    // other non-token characters up front to stop garbage from being reported as valid.
    if (/[<>{}\s"'`]/.test(token)) return false
    if (token.startsWith('eyJ')) return /^[A-Za-z0-9._-]+$/.test(token)
    return /^[A-Za-z0-9._~+/=-]+$/.test(token)
  }

  isEncryptedValue(value: Buffer): boolean {
    return this.decryptor.isEncryptedValue(value)
  }

  async extract(): Promise<ExtractedTeamsToken[]> {
    await this.decryptor.loadCachedKey()
    return this.extractFromCookiesDB()
  }

  async extractIdToken(accountType?: TeamsAccountType): Promise<string | null> {
    await this.decryptor.loadCachedKey()

    const desktopPaths = this.getDesktopCookiesPaths().filter(
      (p) => accountType === undefined || !p.accountTypeKnown || p.accountType === accountType,
    )
    const candidatePaths =
      this.tokenSource === 'desktop' ? desktopPaths : [...desktopPaths, ...this.getBrowserCookiesPaths()]

    if (accountType !== undefined) {
      const knownCandidate = await this.selectNewestAuthToken(candidatePaths.filter((p) => p.accountTypeKnown))
      if (knownCandidate) return knownCandidate.bearer

      // Unknown-account databases are only a fallback: they cannot override a
      // valid candidate from the requested account's known desktop profile.
      const unknownCandidate = await this.selectNewestAuthToken(candidatePaths.filter((p) => !p.accountTypeKnown))
      return unknownCandidate?.bearer ?? null
    }

    const newestCandidate = await this.selectNewestAuthToken(candidatePaths)
    return newestCandidate?.bearer ?? null
  }

  private async selectNewestAuthToken(candidatePaths: TeamsCookiePath[]): Promise<AuthTokenCandidate | null> {
    let newestCandidate: AuthTokenCandidate | null = null

    for (const { path: dbPath } of candidatePaths) {
      if (!dbPath || !existsSync(dbPath)) continue

      const candidates = await this.extractAuthTokenFromSQLite(dbPath)
      for (const candidate of candidates) {
        // The SQL row order and candidate-path order are stable tie-breakers.
        // Keep the earlier candidate when timestamps are equal.
        if (!newestCandidate || candidate.lastAccessUtc > newestCandidate.lastAccessUtc) {
          newestCandidate = candidate
        }
      }
    }

    return newestCandidate
  }

  private async extractAuthTokenFromSQLite(dbPath: string): Promise<AuthTokenCandidate[]> {
    try {
      let localStatePath: string | undefined
      if (this.platform === 'win32') {
        localStatePath = findLocalStatePath(dbPath) ?? undefined
      }

      const hostPredicate = AUTHTOKEN_HOST_PATTERNS.map(() => 'host_key LIKE ?').join(' OR ')
      const sql = `
        SELECT value, encrypted_value, CAST(last_access_utc AS TEXT) AS last_access_utc
        FROM cookies
        WHERE name = ?
        AND (${hostPredicate})
        ORDER BY cookies.last_access_utc DESC, host_key ASC, rowid ASC
        LIMIT ${MAX_AUTHTOKEN_ROWS_PER_DATABASE + 1}
      `
      type CookieRow = {
        value?: string
        encrypted_value?: Uint8Array | Buffer
        last_access_utc?: string | null
      }
      const rows = await this.cookieReader.queryAll<CookieRow>(dbPath, sql, [
        AUTHTOKEN_COOKIE_NAME,
        ...AUTHTOKEN_HOST_PATTERNS.map((pattern) => `%${pattern}%`),
      ])
      if (rows.length > MAX_AUTHTOKEN_ROWS_PER_DATABASE) {
        this.debug(`    authtoken candidate limit reached; inspecting newest ${MAX_AUTHTOKEN_ROWS_PER_DATABASE} rows`)
      }

      const candidates: AuthTokenCandidate[] = []
      for (const row of rows.slice(0, MAX_AUTHTOKEN_ROWS_PER_DATABASE)) {
        if (!row.last_access_utc || !/^\d+$/.test(row.last_access_utc)) {
          this.debug(`    rejected authtoken candidate with invalid access timestamp`)
          continue
        }

        let value = row.value ?? ''
        if ((!value || value.length < 20) && row.encrypted_value && row.encrypted_value.length > 0) {
          const decrypted = this.decryptor.decryptCookieRaw(Buffer.from(row.encrypted_value), localStatePath)
          if (!decrypted) continue
          value = ChromiumCookieDecryptor.stripIntegrityHash(decrypted).toString('utf8')
        }

        const bearer = this.normalizeAuthToken(value)
        if (!bearer) {
          this.debug(`    rejected malformed authtoken candidate`)
          continue
        }
        candidates.push({ bearer, lastAccessUtc: BigInt(row.last_access_utc) })
      }

      return candidates
    } catch (error) {
      this.debug(`    authtoken query error: ${(error as Error).message}`)
      return []
    }
  }

  private normalizeAuthToken(rawValue: string): string | null {
    if (!rawValue) return null
    try {
      const decoded = decodeURIComponent(rawValue)
      const token = decoded.replace(/^Bearer=/i, '').trim()
      return token.length > 20 ? token : null
    } catch {
      return null
    }
  }

  async clearKeyCache(): Promise<void> {
    await this.decryptor.clearKeyCache()
  }

  didCachedKeyFail(): boolean {
    return this.decryptor.didCachedKeyFail()
  }

  private async extractFromCookiesDB(): Promise<ExtractedTeamsToken[]> {
    const results: ExtractedTeamsToken[] = []
    const seenCandidates = new Set<string>()
    const allPaths = this.getTeamsCookiesPaths()

    this.debug(`Scanning ${allPaths.length} candidate cookie path(s)`)

    for (const { path: dbPath, accountType, accountTypeKnown } of allPaths) {
      if (!dbPath) continue

      if (!existsSync(dbPath)) {
        this.debug(`  [skip] ${dbPath} (not found)`)
        continue
      }

      const typeLabel = accountTypeKnown ? accountType : `${accountType}?`
      this.debug(`  [try]  ${dbPath} (${typeLabel})`)

      const candidates = await this.copyAndExtract(dbPath)
      if (candidates.length === 0) {
        this.debug(`  [fail] No valid token candidates extracted`)
        continue
      }

      for (const token of candidates) {
        if (!this.isValidSkypeToken(token)) {
          this.debug(`  [fail] Rejected malformed token candidate (${token.length} chars)`)
          continue
        }

        // A token seen in both known desktop profiles must retain each profile's
        // account label so one profile cannot erase the other before API validation.
        const dedupeKey = accountTypeKnown ? `${accountType}:${token}` : `unknown:${token}`
        if (seenCandidates.has(dedupeKey)) {
          this.debug(`  [skip] Duplicate token candidate (already extracted from another path)`)
          continue
        }

        this.debug(`  [ok]   Extracted token candidate (${token.length} chars)`)
        results.push({ token, accountType, accountTypeKnown })
        seenCandidates.add(dedupeKey)
      }
    }

    this.debug(`Extraction complete: ${results.length} token(s) found`)
    return results
  }

  private async copyAndExtract(dbPath: string): Promise<string[]> {
    let tempPath = dbPath

    try {
      tempPath = this.copyDatabaseToTemp(dbPath, dbPath)

      let localStatePath: string | undefined
      if (this.platform === 'win32') {
        localStatePath = findLocalStatePath(dbPath) ?? undefined
        if (localStatePath) {
          this.debug(`    Local State (from cookie path): ${localStatePath}`)
        } else {
          localStatePath = this.getLocalStatePath()
          if (existsSync(localStatePath)) {
            this.debug(`    Local State (fallback): ${localStatePath}`)
          } else {
            this.debug(`    Local State not found (tried fallback: ${localStatePath})`)
            localStatePath = undefined
          }
        }
      }

      return await this.extractFromSQLite(tempPath, localStatePath)
    } catch (error) {
      this.debug(`    Copy/extract error: ${(error as Error).message}`)
      return []
    } finally {
      this.cleanupTempFile(tempPath)
    }
  }

  private async extractFromSQLite(dbPath: string, localStatePath?: string): Promise<string[]> {
    try {
      const hostPredicate = TEAMS_HOST_PATTERNS.map(() => 'host_key LIKE ?').join(' OR ')
      const sql = `
        SELECT value, encrypted_value
        FROM cookies
        WHERE name = ?
        AND (${hostPredicate})
        ORDER BY last_access_utc DESC
        LIMIT ${MAX_SKYPE_TOKEN_CANDIDATES_PER_DATABASE}
      `
      type CookieRow = { value?: string; encrypted_value?: Uint8Array | Buffer }
      const rows = await this.cookieReader.queryAll<CookieRow>(dbPath, sql, [
        SKYPETOKEN_COOKIE_NAME,
        ...TEAMS_HOST_PATTERNS.map((pattern) => `%${pattern}%`),
      ])
      const candidates: string[] = []
      const seen = new Set<string>()

      for (const row of rows) {
        let token = ''

        if (row.value && row.value.length >= 50) {
          this.debug(`    Found plaintext cookie candidate (${row.value.length} chars)`)
          token = row.value
        } else if (row.encrypted_value && row.encrypted_value.length > 0) {
          const encBuf = Buffer.from(row.encrypted_value)
          const isEncrypted = this.isEncryptedValue(encBuf)
          this.debug(`    Found encrypted cookie candidate (${encBuf.length} bytes, encrypted=${isEncrypted})`)

          const decryptedBuf = this.decryptor.decryptCookieRaw(encBuf, localStatePath)
          if (!decryptedBuf) {
            this.debug(`    Decryption failed`)
            continue
          }

          this.debug(`    Decrypted cookie candidate (${decryptedBuf.length} bytes)`)
          token = this.postProcessDecrypted(decryptedBuf)
        }

        if (!this.isValidSkypeToken(token)) {
          this.debug(`    Rejected malformed cookie candidate (${token.length} chars)`)
          continue
        }
        if (seen.has(token)) continue
        candidates.push(token)
        seen.add(token)
      }

      return candidates
    } catch (error) {
      this.debug(`    SQLite query error: ${(error as Error).message}`)
      return []
    }
  }

  private postProcessDecrypted(raw: Buffer): string {
    const stripped = ChromiumCookieDecryptor.stripIntegrityHash(raw)
    if (stripped !== raw) return stripped.toString('utf8')

    const str = raw.toString('utf8')

    const jwtStart = str.indexOf('eyJ')
    if (jwtStart > 0 && jwtStart <= 32) return str.substring(jwtStart)

    if (str.length > 32) {
      const possibleToken = str.substring(32)
      if (possibleToken.length > 50 && /^[A-Za-z0-9._-]+$/.test(possibleToken.substring(0, 50))) {
        return possibleToken
      }
    }

    return str
  }

  private copyDatabaseToTemp(sourcePath: string, _destPath: string): string {
    return sourcePath
  }

  private cleanupTempFile(_tempPath: string): void {}

  private decryptAESGCM(encryptedData: Buffer, key: Buffer): string | null {
    return this.decryptor.decryptAESGCM(encryptedData, key)
  }

  private getKeychainPassword(): string | null {
    for (const variant of this.getKeychainVariants()) {
      const password = this.execSecurityCommand(variant.service, variant.account)
      if (password) return password
    }

    return null
  }

  private execSecurityCommand(service: string, account: string): string | null {
    try {
      const safeService = service.replace(/"/g, '\\"')
      const safeAccount = account.replace(/"/g, '\\"')
      const result = execSync(`security find-generic-password -s "${safeService}" -a "${safeAccount}" -w 2>/dev/null`, {
        encoding: 'utf8',
      })
      return result.trim() || null
    } catch {
      return null
    }
  }

  async isTeamsRunning(): Promise<boolean> {
    return this.checkProcessRunning(this.getProcessName())
  }

  private getProcessName(): string {
    return TEAMS_PROCESS_NAMES[this.platform] || TEAMS_PROCESS_NAMES.linux
  }

  private checkProcessRunning(processName: string): boolean {
    try {
      if (this.platform === 'win32') {
        const result = execSync(`tasklist /FI "IMAGENAME eq ${processName}" 2>nul`, {
          encoding: 'utf8',
        })
        return result.toLowerCase().includes(processName.toLowerCase())
      }

      const result = execSync(`pgrep -f "${processName}" 2>/dev/null || true`, {
        encoding: 'utf8',
      })
      return result.trim().length > 0
    } catch {
      return false
    }
  }
}
