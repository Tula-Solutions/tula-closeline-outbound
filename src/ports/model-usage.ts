/** What a month of model use came to for one Organization and model. */
export type ModelUsageTotals = {
  inputTokens: number
  outputTokens: number
  requests: number
  costMicros: number
}

/** Where model spend is counted per Organization and UTC month; the budget is checked against it. */
export type ModelUsageStore = {
  /** Micro-dollars spent so far in the month (`month` is its first day, `YYYY-MM-01`), over all models. */
  spentMicros: (organizationId: string, month: string) => Promise<number>
  /** Adds one call's tokens and cost to the month's row for that model. */
  record: (
    organizationId: string,
    month: string,
    model: string,
    usage: Omit<ModelUsageTotals, 'requests'>
  ) => Promise<void>
}
