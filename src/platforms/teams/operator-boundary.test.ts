import { describe, expect, it } from 'bun:test'

import { assertTeamsOperatorBoundary, TEAMS_COMPANION_REQUIRED } from './operator-boundary'

describe('Teams macOS operator boundary', () => {
  it('rejects the raw macOS CLI', () => {
    expect(() => assertTeamsOperatorBoundary('darwin', undefined)).toThrow(TEAMS_COMPANION_REQUIRED)
  })

  it('rejects a forged companion environment flag without signed invocation proof', () => {
    expect(() => assertTeamsOperatorBoundary('darwin', '1', () => false)).toThrow(TEAMS_COMPANION_REQUIRED)
  })

  it('accepts a signed companion child with both mediated state and invocation proof', () => {
    expect(() => assertTeamsOperatorBoundary('darwin', '1', () => true)).not.toThrow()
  })

  it('leaves the upstream Windows lane unchanged', () => {
    expect(() =>
      assertTeamsOperatorBoundary('win32', undefined, () => {
        throw new Error('Windows must not invoke the macOS verifier')
      }),
    ).not.toThrow()
  })
})
