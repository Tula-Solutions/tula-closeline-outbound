import type { ModelUsageStore, ModelUsageTotals } from '~/ports/model-usage'

/** The usage store in memory; `rows` is readable by tests. */
export type MemoryModelUsageStore = ModelUsageStore & { rows: Map<string, ModelUsageTotals> }

/** Builds the in-memory usage store. */
export function createMemoryModelUsageStore(): MemoryModelUsageStore {
  const rows = new Map<string, ModelUsageTotals>()
  return {
    rows,
    async spentMicros(organizationId, month) {
      let sum = 0
      for (const [key, row] of rows) {
        if (key.startsWith(`${organizationId}|${month}|`)) {
          sum += row.costMicros
        }
      }
      return sum
    },
    async record(organizationId, month, model, usage) {
      const key = `${organizationId}|${month}|${model}`
      const row = rows.get(key) ?? { inputTokens: 0, outputTokens: 0, requests: 0, costMicros: 0 }
      rows.set(key, {
        inputTokens: row.inputTokens + usage.inputTokens,
        outputTokens: row.outputTokens + usage.outputTokens,
        requests: row.requests + 1,
        costMicros: row.costMicros + usage.costMicros,
      })
    },
  }
}
