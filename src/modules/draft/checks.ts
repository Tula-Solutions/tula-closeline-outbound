import { DRAFT_CHECKS, type OutreachDraft } from 'tula-closeline-contract'

/** What the five checks look at; every text is already cleaned. */
export type CheckInput = {
  subject: string
  body: string
  /** Claims whose source id the model was not given as citable. */
  unresolvedClaims: number
  /** The text of every cited source, the Prospect's values, the goal and the sign-off. */
  supportingText: readonly string[]
  bannedPhrases: readonly string[]
  maxLengthCharacters: number
  truncated: boolean
  prospectFirstName: string | undefined
}

/** The most findings the contract lets one check report. */
const MAX_CHECK_COUNT = 1000
const NUMBER = /\$?\d[\d,]*(?:\.\d+)?%?/g
const GREETING = /^\s*(?:hi|hello|hey|dear)\s+([\p{L}'’-]+)/iu

/** The numbers and prices in a text, written the same way whatever the comma, dollar sign or percent. */
function numbersIn(text: string): Set<string> {
  return new Set(
    (text.match(NUMBER) ?? []).map((token) => token.replace(/[$,%]/g, '').replace(/\.$/, ''))
  )
}

/** Runs the five Draft checks in the contract's order; `pass` exactly when nothing was found. */
export function runChecks(input: CheckInput): OutreachDraft['checks'] {
  const text = `${input.subject}\n${input.body}`
  const supported = new Set(input.supportingText.flatMap((t) => [...numbersIn(t)]))
  const counts: Record<(typeof DRAFT_CHECKS)[number], number> = {
    citations_resolve: input.unresolvedClaims,
    claims_supported: Math.min(
      [...numbersIn(text)].filter((n) => !supported.has(n)).length,
      MAX_CHECK_COUNT
    ),
    banned_phrase: input.bannedPhrases.filter((p) => text.toLowerCase().includes(p.toLowerCase()))
      .length,
    length: input.truncated || input.body.length > input.maxLengthCharacters ? 1 : 0,
    name_match: namesSomeoneElse(input.body, input.prospectFirstName) ? 1 : 0,
  }
  return DRAFT_CHECKS.map((check) => ({
    check,
    result: counts[check] === 0 ? ('pass' as const) : ('fail' as const),
    count: counts[check],
  }))
}

function namesSomeoneElse(body: string, firstName: string | undefined): boolean {
  const greeted = GREETING.exec(body)?.[1]
  return (
    greeted !== undefined &&
    firstName !== undefined &&
    firstName !== '' &&
    greeted.toLowerCase() !== firstName.toLowerCase()
  )
}
