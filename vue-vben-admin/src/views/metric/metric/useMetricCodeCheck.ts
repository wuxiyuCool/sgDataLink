import { computed, onScopeDispose, ref } from 'vue'

import { getApiErrorMessage } from '/@/api/databridge/http'
import { checkMetricCodesApi, type MetricCodeCheckItem } from '/@/api/databridge/metric'
import { useMessage } from '/@/hooks/web/useMessage'

/**
 * 批量向导第②步的「编码事前校验」（契约 1.17）。
 * 判定只信后端：这里缓存的是 code-check 的回执，界面不另写一套占用规则。
 * 两个批量向导（从表生成原子指标 / 批量派生）共用，避免同一份规则长两遍。
 */

/** 编码改动后的防抖窗口：再短就是每敲一个字打一次管理后端 */
const CODE_CHECK_DEBOUNCE_MS = 500
/** 后端单次只接 50 个 code（与 POST /metrics/batch 同口径），超了分批问 */
const CODE_CHECK_BATCH = 50

export interface CodeCheckRow {
  code: string
}

export function useMetricCodeCheck(getPicked: () => CodeCheckRow[]) {
  const { createMessage } = useMessage()

  /** code-check 结果按编码建索引：判定只信后端，这里仅是展示缓存 */
  const codeIssues = ref<Record<string, MetricCodeCheckItem>>({})
  /** 已经问过后端的编码——改动重查时只问没问过的，不整表刷 */
  const askedCodes = ref<Set<string>>(new Set())
  const codeChecking = ref(false)
  /** 上一次批量提交的成败留痕：回第②步时失败行继续红，已落库的行不再算冲突 */
  const createdCodes = ref<Set<string>>(new Set())
  const failedMessages = ref<Record<string, string>>({})
  let codeCheckTimer: ReturnType<typeof setTimeout> | null = null
  /** 上一次发出去的批次编码清单（含重复次数）：防抖重查拿它做差异，才知道哪些结论过期了 */
  let lastBatchCodes: string[] = []

  function trimCode(code: string) {
    return String(code || '').trim()
  }

  /** 参与编码校验与冲突计数的行＝勾选的行：没勾的不会提交，报它冲突只会误导 */
  const pickedRows = computed(() => getPicked())

  function rowIssue(code: string) {
    return codeIssues.value[trimCode(code)]
  }

  /** 库里被占 / 本批重复 / 格式非法——后端说不可用就是不可用 */
  function isCodeConflict(row: CodeCheckRow) {
    if (createdCodes.value.has(trimCode(row.code))) return false // 已落库的行不重投就不算冲突
    const issue = rowIssue(row.code)
    return Boolean(issue && !issue.available)
  }

  const codeConflictRows = computed(() => pickedRows.value.filter((row) => isCodeConflict(row)))

  /** 「一键补后缀」治得了的只有占用与批内重复；格式非法得人来改，追加后缀也还是非法 */
  const suffixTargets = computed(() =>
    codeConflictRows.value.filter((row) =>
      ['taken', 'duplicate-in-request'].includes(String(rowIssue(row.code)?.reason)),
    ),
  )

  const codeConflictSummary = computed(() => {
    const tally = codeConflictRows.value.reduce(
      (acc, row) => {
        const reason = rowIssue(row.code)?.reason
        if (reason === 'invalid') acc.invalid += 1
        else if (reason === 'taken') acc.taken += 1
        else acc.duplicated += 1
        return acc
      },
      { taken: 0, duplicated: 0, invalid: 0 },
    )
    const pieces: string[] = []
    if (tally.taken)
      pieces.push(`${tally.taken} 行编码已被占用（含已删除指标，编码终身制不可复用）`)
    if (tally.duplicated) pieces.push(`${tally.duplicated} 行在本批内重复`)
    if (tally.invalid) pieces.push(`${tally.invalid} 行格式非法`)
    pieces.push('这些行提交时会被后端逐条拒绝，其余行照常创建')
    return pieces.join('；')
  })

  /** 红色＝编码冲突，或者上一次提交被后端拒过（原因可能不是编码，但那行确实要人改） */
  function isRowError(row: CodeCheckRow) {
    const code = trimCode(row.code)
    if (isCodeConflict(row)) return true
    return Boolean(failedMessages.value[code]) && !createdCodes.value.has(code)
  }

  function rowCodeHint(row: CodeCheckRow) {
    const code = trimCode(row.code)
    const parts: string[] = []
    // 已落库的行：后端此刻当然会说「被占用」，占用者就是它自己，再念一遍只会让人以为出了新问题
    if (createdCodes.value.has(code)) return '已创建（重投会撞码）'
    const issue = rowIssue(code)
    if (issue && !issue.available) {
      if (issue.reason === 'invalid') {
        parts.push(`编码格式非法：小写字母开头、仅 a-z0-9_、长度 3~64（当前「${code || '空'}」）`)
      } else if (issue.reason === 'duplicate-in-request') {
        parts.push('本批内重复：另有勾选行用同一个编码，提交会被逐条拒')
      } else if (issue.reason === 'taken') {
        const by = issue.takenBy
        const who = by ? `${by.name}（${by.id}，状态 ${by.status}）` : '已有指标'
        parts.push(
          by?.deleted ? `该编码被已删除指标占用，编码不可复用：${who}` : `编码已被占用：${who}`,
        )
      }
    }
    if (failedMessages.value[code]) parts.push(`上次提交失败：${failedMessages.value[code]}`)
    return parts.join('；')
  }

  function uniqueCodes(list: CodeCheckRow[]) {
    return [...new Set(list.map((row) => trimCode(row.code)).filter(Boolean))]
  }

  /**
   * 当前批次（勾选行）的编码清单，**保留重复出现**：
   * 「本批内重复」判的就是同一个请求里这个 code 出现几次，界面只负责把批次如实报上去，不替后端下结论。
   */
  function batchCodeList() {
    return pickedRows.value.map((row) => trimCode(row.code)).filter(Boolean)
  }

  /**
   * 防抖重查的最小集合：只有「出现次数变了」的编码才需要再问。
   * 被占用/格式非法不会因为编辑别的行而改变；会翻面的只有本批重复——
   * A 把 x 改成 z，就要把 x（少了一次）和 z（多了一次）按当前次数一起再问一遍，
   * 否则会留下「两条一样却都绿」或「已经唯一了还红着」的过期结论。
   */
  function diffCodes() {
    const next = batchCodeList()
    const before = new Map<string, number>()
    lastBatchCodes.forEach((code) => before.set(code, (before.get(code) || 0) + 1))
    const after = new Map<string, number>()
    next.forEach((code) => after.set(code, (after.get(code) || 0) + 1))
    const request: string[] = []
    after.forEach((count, code) => {
      if (askedCodes.value.has(code) && (before.get(code) || 0) === count) return
      for (let i = 0; i < count; i += 1) request.push(code)
    })
    return request
  }

  function mergeCodeIssues(items: MetricCodeCheckItem[]) {
    if (!items.length) return
    const merged = { ...codeIssues.value }
    items.forEach((item) => {
      merged[item.code] = item
    })
    codeIssues.value = merged
  }

  function resetCodeChecks() {
    if (codeCheckTimer) {
      clearTimeout(codeCheckTimer)
      codeCheckTimer = null
    }
    codeIssues.value = {}
    askedCodes.value = new Set()
    lastBatchCodes = []
    createdCodes.value = new Set()
    failedMessages.value = {}
  }

  /** 编码改动后 500ms 防抖重查，且只问受影响的那几个编码 */
  function scheduleCodeCheck() {
    if (codeCheckTimer) clearTimeout(codeCheckTimer)
    codeCheckTimer = setTimeout(() => {
      codeCheckTimer = null
      void runCodeCheck()
    }, CODE_CHECK_DEBOUNCE_MS)
  }

  /**
   * 事前校验：一次问一批。传 codes＝显式指定（进第②步的全量、补后缀后的复查），
   * 不传＝只问 diffCodes() 里受影响的。失败不拦用户：回到「提交才报错」的老行为，并说清楚。
   */
  async function runCodeCheck(codes?: string[]) {
    const targets = codes ?? diffCodes()
    lastBatchCodes = batchCodeList()
    if (!targets.length) return
    codeChecking.value = true
    const asked = new Set(askedCodes.value)
    targets.forEach((code) => asked.add(code))
    askedCodes.value = asked
    try {
      // 后端单次 ≤50（超出 40001）；分批问会让「本批内重复」漏在批次边界上，
      // 但一次提交 50 行以上本来就过不了 POST /metrics/batch 的上限，不会出现「全绿却提交失败」
      for (let i = 0; i < targets.length; i += CODE_CHECK_BATCH) {
        // eslint-disable-next-line no-await-in-loop
        const checked = await checkMetricCodesApi(targets.slice(i, i + CODE_CHECK_BATCH))
        mergeCodeIssues(checked?.items || [])
      }
    } catch (error) {
      const rollback = new Set(askedCodes.value)
      targets.forEach((code) => rollback.delete(code))
      askedCodes.value = rollback
      createMessage.warning(
        getApiErrorMessage(error, '编码占用校验暂不可用，提交时仍由后端逐条把关'),
      )
    } finally {
      codeChecking.value = false
    }
  }

  /** 回第②步时整批重查：刚成功的编码此刻确实「被占用」（占用者就是它自己） */
  function refreshAllCodes() {
    return runCodeCheck(batchCodeList())
  }

  /**
   * 提交回来的成败写进留痕：已落库的行不再算冲突，被拒的行继续红并带上后端原话。
   * results.index 与上次提交的条目按序对齐，故由调用方传 results。
   */
  function recordSubmitOutcome(results: { ok: boolean; code?: string; message?: string }[]) {
    createdCodes.value = new Set(results.filter((r) => r.ok).map((r) => trimCode(r.code || '')))
    const failures: Record<string, string> = {}
    results
      .filter((r) => !r.ok)
      .forEach((r) => {
        failures[trimCode(r.code || '')] = r.message || '后端已拒绝'
      })
    failedMessages.value = failures
  }

  /**
   * 一键补后缀：只对占用/批内重复的行按 `_2`、`_3`… 递增，直到落在「本批已知占用集合」之外。
   * 已知集合＝本批全部编码 + code-check 回过「不可用」的编码；补完立刻复查，真撞没撞后端说了算。
   * 批内重复只动后出现的行（第一条保持原编码，少改一处）。用户不点就一个字符都不改。
   */
  async function handleAddSuffix() {
    const targets = suffixTargets.value
    if (!targets.length) {
      createMessage.warning('没有可补后缀的冲突行（格式非法的编码请手工改，补后缀治不了）')
      return
    }
    const blocked = new Set<string>(uniqueCodes(pickedRows.value))
    Object.entries(codeIssues.value).forEach(([code, item]) => {
      if (!item.available) blocked.add(code)
    })
    const renamed: string[] = []
    const skipped: string[] = []
    const keptFirst = new Set<string>()
    targets.forEach((row) => {
      const base = trimCode(row.code)
      if (rowIssue(base)?.reason === 'duplicate-in-request' && !keptFirst.has(base)) {
        keptFirst.add(base)
        return
      }
      let next = ''
      for (let n = 2; n <= 999; n += 1) {
        const candidate = `${base}_${n}`
        if (candidate.length > 64) break // 编码上限 64，补不动了，交回人工
        if (!blocked.has(candidate)) {
          next = candidate
          break
        }
      }
      if (!next) {
        skipped.push(base)
        return
      }
      blocked.add(next)
      row.code = next
      renamed.push(next)
    })
    // 补完立刻复查受影响的编码（含保持原编码的那条，它可能刚从「重复」变成「唯一」）
    await runCodeCheck(diffCodes())
    if (!renamed.length) {
      createMessage.warning('冲突编码都已到 64 位上限，补不了后缀，请手工缩短编码')
      return
    }
    createMessage.success(
      `已为 ${renamed.length} 行补后缀${
        skipped.length ? `，${skipped.length} 行编码太长需手工处理` : ''
      }；指标名称是否要跟着改请自查`,
    )
  }

  onScopeDispose(() => {
    if (codeCheckTimer) clearTimeout(codeCheckTimer)
  })

  return {
    codeChecking,
    codeConflictRows,
    codeConflictSummary,
    suffixTargets,
    isCodeConflict,
    isRowError,
    refreshAllCodes,
    resetCodeChecks,
    handleAddSuffix,
    rowCodeHint,
    runCodeCheck,
    scheduleCodeCheck,
    recordSubmitOutcome,
    pickedRows,
  }
}
