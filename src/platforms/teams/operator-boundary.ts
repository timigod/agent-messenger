import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'

export const TEAMS_COMPANION_REQUIRED =
  'On macOS, Teams operations must use the signed Agent Messenger Teams Bridge dispatcher.'

export function verifyTeamsCompanionInvocation(executablePath = process.execPath): boolean {
  const verifier = join(dirname(executablePath), 'launcher')
  const result = spawnSync(verifier, ['--verify-invocation'], {
    env: {},
    stdio: 'ignore',
    timeout: 2_000,
  })
  return result.status === 0 && result.signal === null && result.error === undefined
}

export function assertTeamsOperatorBoundary(
  platform: NodeJS.Platform = process.platform,
  companionMediated = process.env.AGENT_TEAMS_COMPANION_MEDIATED,
  verifyInvocation: () => boolean = verifyTeamsCompanionInvocation,
): void {
  if (platform === 'darwin' && (companionMediated !== '1' || !verifyInvocation())) {
    throw new Error(TEAMS_COMPANION_REQUIRED)
  }
}
