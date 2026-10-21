import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { QuotaStats, QuotaWindow } from '../types'

const stats = atom({ plugin: 'quota-band', key: 'stats' } as const, {
  turn: 0,
  speed: null,
  turnCost: null,
  total: 0,
  costAtStart: 0,
  context: 0,
} as QuotaStats)
const windows = atom({ plugin: 'quota-band', key: 'windows' } as const, [])
const cacheExpiresAt = atom({ plugin: 'quota-band', key: 'cacheExpiresAt' } as const, null)
const now = atom({ plugin: 'quota-band', key: 'now' } as const, 0)

const LABELS: Record<string, string> = { five_hour: '5h', seven_day: '周', spend_limit: '花费' }
const BAR = 10
const DIVIDER = 'cyan'
const SPEED = '#8b8cf8'
const MONEY = '#4caf6e'
const CACHE = '#4fb3a9'
const WARN = '#e2a94e'
const ALERT = '#e0846b'

// Output speed: ignore replies too short or too quick to time fairly.
const MIN_TOKENS = 20
const MIN_SECONDS = 0.5
const MAX_SPEED = 1000

// The prompt cache lives an hour after the last answer.
const CACHE_TTL_MS = 60 * 60 * 1000
const CACHE_WARN_S = 20 * 60
const CACHE_ALERT_S = 10 * 60

// Narrower than these, the row drops its bars, then its labels and total cost.
const FULL_COLUMNS = 110
const MID_COLUMNS = 80

const level = (pct: number) => (pct >= 80 ? ALERT : pct >= 50 ? WARN : MONEY)

const bar = (pct: number) => {
  const full = Math.max(0, Math.min(BAR, Math.round((pct / 100) * BAR)))
  return '█'.repeat(full) + '░'.repeat(BAR - full)
}

const pad = (n: number) => String(n).padStart(2, '0')
const usd = (n: number) => `$${n.toFixed(2)}`

const resetIn = (resetsAt: string | undefined, at: number) => {
  if (!resetsAt) return ''
  const min = Math.max(0, Math.round((Date.parse(resetsAt) - at) / 60000))
  if (Number.isNaN(min)) return ''
  if (min < 60) return `${min}分钟后重置`
  if (min < 24 * 60) return `${Math.floor(min / 60)}h${min % 60}m后重置`
  return `${Math.round(min / 1440)}天后重置`
}

async function refresh($: EngineInterface) {
  const { rateLimits, cost, context } = await $.session.usage()
  const list: QuotaWindow[] = rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt }))
  await update($, windows, () => list)
  const at = await $.clock.now()
  await update($, now, () => at)
  const total = cost?.usd ?? 0
  const turn = await $.session.turns()
  await update($, stats, s => ({
    ...s,
    turn,
    total,
    turnCost: s.turnCost === null ? null : total - s.costAtStart,
    context: context.percent ?? s.context,
  }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await refresh($)
    $.clock.every(1000, async () => {
      const at = await $.clock.now()
      await update($, now, () => at)
    })
    $.clock.every(60_000, () => refresh($))
    return started
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const total = (await $.session.usage()).cost?.usd ?? 0
      await update($, stats, s => ({ ...s, costAtStart: total, turnCost: 0 }))
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)

    // Timed from the response's first chunk, so time-to-first-token is left out.
    let startedAt: number | null = null
    for await (const chunk of next(e)) {
      if (startedAt === null) startedAt = await $.clock.now()
      if (chunk.kind === 'stop' && chunk.usage !== null) {
        const tokens = chunk.usage.output_tokens
        const seconds = ((await $.clock.now()) - startedAt) / 1000
        const tps = tokens / seconds
        if (tokens >= MIN_TOKENS && seconds >= MIN_SECONDS && tps <= MAX_SPEED) {
          await update($, stats, s => ({ ...s, speed: Math.round(tps) }))
        }
      }
      yield chunk
    }
    await refresh($)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await refresh($)
    if (e.agentId === undefined) {
      const at = await $.clock.now()
      await update($, cacheExpiresAt, () => at + CACHE_TTL_MS)
    }
    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // The desktop draws desktop-cockpit's band instead.
    if (e.props.hasSurvey || e.surface === 'desktop') return next(e)
    const s = await read($, stats)
    const list = await read($, windows)
    const expiresAt = await read($, cacheExpiresAt)
    const at = await read($, now)
    const { Box, Text } = $.ui.resolve(e)
    const cols = e.props.bodyColumns
    const isFull = cols >= FULL_COLUMNS
    const isMid = cols >= MID_COLUMNS

    // A bold line marking where the transcript ends and the tool area begins.
    const divider = (
      <Text key="divider" color={DIVIDER} wrap="truncate-end">
        {'━'.repeat(Math.max(1, cols))}
      </Text>
    )

    const left = expiresAt === null || at === 0 ? null : Math.max(0, Math.floor((expiresAt - at) / 1000))
    const cacheColor =
      e.props.isWorking || left === null ? CACHE : left <= CACHE_ALERT_S ? ALERT : left <= CACHE_WARN_S ? WARN : CACHE
    const cacheText =
      e.props.isWorking ? '…' : left === null ? '—' : left === 0 ? '已过期' : `${pad(Math.floor(left / 60))}:${pad(left % 60)}`

    const row = (
      <Box key="row" flexDirection="row" columnGap={isMid ? 3 : 2} paddingX={1} flexWrap="nowrap" overflow="hidden">
        <Box flexDirection="row" columnGap={1} flexShrink={0}>
          <Text dimColor>{isMid ? 'Turn' : '#'}</Text>
          <Text bold>{String(s.turn)}</Text>
        </Box>
        <Box flexDirection="row" columnGap={1} flexShrink={0}>
          <Text color={SPEED}>⚡</Text>
          <Text bold>{s.speed === null ? '—' : isMid ? `${s.speed} tok/s` : `${s.speed}/s`}</Text>
        </Box>
        <Box flexDirection="row" columnGap={1} flexShrink={0}>
          <Text bold color={MONEY}>{s.turnCost === null ? '—' : usd(s.turnCost)}</Text>
          {isMid ? <Text dimColor>|</Text> : null}
          {isMid ? <Text bold>{usd(s.total)}</Text> : null}
        </Box>
        <Box flexDirection="row" columnGap={1} flexShrink={0}>
          <Text color={cacheColor}>⧗</Text>
          <Text bold color={cacheColor}>{cacheText}</Text>
        </Box>
        {list.map(w => (
          <Box key={w.kind} flexDirection="row" columnGap={1} flexShrink={0}>
            <Text dimColor>{LABELS[w.kind] ?? w.kind}</Text>
            {isFull ? <Text color={level(w.percentUsed)}>{bar(w.percentUsed)}</Text> : null}
            <Text bold color={level(w.percentUsed)}>{`${Math.round(w.percentUsed)}%`}</Text>
            {isFull ? <Text dimColor>{resetIn(w.resetsAt, at)}</Text> : null}
          </Box>
        ))}
        <Box flexGrow={1} flexShrink={1} />
        <Box flexDirection="row" columnGap={1} flexShrink={0}>
          <Text dimColor>上下文</Text>
          {isMid ? <Text color={level(s.context)}>{bar(s.context)}</Text> : null}
          <Text bold color={level(s.context)}>{`${Math.round(s.context)}%`}</Text>
        </Box>
      </Box>
    )

    // Keep whatever the plugins beneath draw in the band under ours.
    const below = await next(e)
    return (
      <Box flexDirection="column">
        {divider}
        {row}
        {below}
      </Box>
    )
  })
}
