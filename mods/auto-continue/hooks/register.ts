import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AutoContinueWait } from '../types'

const isEnabledAtom = atom({ plugin: 'auto-continue', key: 'isEnabled' } as const, null)
const maxWaitAtom = atom({ plugin: 'auto-continue', key: 'maxWaitMs' } as const, null)
const limitedSince = atom({ plugin: 'auto-continue', key: 'limitedSince' } as const, null)
const waitAtom = atom({ plugin: 'auto-continue', key: 'wait' } as const, null)
const attempts = atom({ plugin: 'auto-continue', key: 'attempts' } as const, 0)
const scheduledAtom = atom({ plugin: 'auto-continue', key: 'scheduled' } as const, null)

const HOUR = 60 * 60 * 1000
// Sent a little after the reset, so the new window is surely open.
const MARGIN_MS = 2 * 60 * 1000
// With no reset time reported, try again this often until the wait allowed runs out.
const POLL_MS = 30 * 60 * 1000
// Prompts sent in a row that hit the limit again before giving up.
const MAX_ATTEMPTS = 3
const MODE = 'auto-continue'
const DEFAULT_PROMPT = '额度已刷新，请从中断的地方继续完成刚才的任务。'
const DEFAULT_SCHEDULED_PROMPT = 'continue'
const LABELS: Record<string, string> = { five_hour: '5 小时额度', seven_day: '周额度', spend_limit: '花费额度' }
const USAGE =
  '用法：/auto-continue on [1d|12h|90m] · off · at 14:30 [消息] · at 10/22 09:00 [消息] · in 2h [消息] · cancel · 不带参数看状态。'

// The manifest's options, read once per load by register.
let config = {
  isEnabledByDefault: false,
  maxWaitMs: 24 * HOUR,
  prompt: DEFAULT_PROMPT,
  scheduledPrompt: DEFAULT_SCHEDULED_PROMPT,
  isWeeklyOnly: false,
}
// The module's own timers: a reload drops them, and session.start arms them again from $.state.
let timer: Timer | undefined
let scheduleTimer: Timer | undefined

const pad = (n: number) => String(n).padStart(2, '0')
const when = (ms: number) => {
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const span = (ms: number) => {
  const min = Math.round(ms / 60000)
  if (min < 60) return `${min} 分钟`
  if (min < 24 * 60) return `${Math.round((min / 60) * 10) / 10} 小时`
  return `${Math.round((min / 1440) * 10) / 10} 天`
}
const label = (kind: string | null) => (kind ? (LABELS[kind] ?? kind) : '额度')
const watched = (kind: string) => !config.isWeeklyOnly || kind === 'seven_day'

// `1d`, `12h`, `90m`, `1.5天`, `8小时`; a bare number is hours.
const parseSpan = (text: string) => {
  const m = /^(\d+(?:\.\d+)?)\s*(d|h|m|天|小时|分钟|分)?$/i.exec(text.trim())
  if (!m) return null
  const n = Number(m[1])
  const unit = (m[2] ?? 'h').toLowerCase()
  const ms = unit === 'd' || unit === '天' ? n * 24 * HOUR : unit === 'm' || unit.startsWith('分') ? n * 60000 : n * HOUR
  return ms > 0 ? ms : null
}

// `14:30` (today, or tomorrow once it has passed) or `10/22 14:30` (this year, or next once passed), local time.
const parseTime = (text: string, now: number) => {
  const m = /^(?:(\d{1,2})[/-](\d{1,2})\s+)?(\d{1,2})[:：](\d{2})$/.exec(text.trim())
  if (!m) return null
  const [hour, minute] = [Number(m[3]), Number(m[4])]
  if (hour > 23 || minute > 59) return null
  const d = new Date(now)
  if (m[1]) d.setMonth(Number(m[1]) - 1, Number(m[2]))
  d.setHours(hour, minute, 0, 0)
  if (d.getTime() <= now) m[1] ? d.setFullYear(d.getFullYear() + 1) : d.setDate(d.getDate() + 1)
  return d.getTime()
}

async function isEnabled($: EngineInterface) {
  return (await read($, isEnabledAtom)) ?? config.isEnabledByDefault
}

async function maxWait($: EngineInterface) {
  return (await read($, maxWaitAtom)) ?? config.maxWaitMs
}

async function showStatus($: EngineInterface) {
  const wait = await read($, waitAtom)
  const scheduled = await read($, scheduledAtom)
  const parts = [
    wait && (await isEnabled($)) ? `⏳ ${label(wait.kind)}用完 · ${when(wait.wakeAt)} 自动继续` : null,
    scheduled ? `⏰ ${when(scheduled.at)} 定时继续` : null,
  ].filter(Boolean)
  $.ui.status(parts.length > 0 ? parts.join('  ') : undefined)
}

function armSchedule($: EngineInterface, at: number, now: number) {
  scheduleTimer?.cancel()
  scheduleTimer = $.clock.after(Math.max(1000, at - now), () => void fireSchedule($).catch(() => undefined))
}

async function cancelSchedule($: EngineInterface) {
  scheduleTimer?.cancel()
  scheduleTimer = undefined
  await update($, scheduledAtom, () => null)
  await showStatus($)
}

async function fireSchedule($: EngineInterface) {
  scheduleTimer = undefined
  const scheduled = await read($, scheduledAtom)
  if (scheduled === null) return
  await update($, scheduledAtom, () => null)
  await showStatus($)
  $.ui.toast('到点了，定时继续')
  await $.prompt.submit({ text: scheduled.text }).catch((err: unknown) => $.ui.toast(`定时继续没能发出消息：${String(err)}`))
}

// `at 14:30 [text]`, `at 10/22 09:00 [text]` or `in 2h [text]`: send the text (or the option's) then.
async function schedule($: EngineInterface, verb: 'at' | 'in', words: string[]) {
  const now = await $.clock.now()
  const hasDate = verb === 'at' && /^\d{1,2}[/-]\d{1,2}$/.test(words[0] ?? '')
  const timeWords = hasDate ? 2 : 1
  const given = words.slice(0, timeWords).join(' ')
  const at = verb === 'at' ? parseTime(given, now) : (s => (s === null ? null : now + s))(parseSpan(given))
  if (at === null) {
    return verb === 'at'
      ? `看不懂时间「${given}」：写成 14:30 或 10/22 09:00 这样。`
      : `看不懂时长「${given}」：写成 2h、90m、1d 这样。`
  }
  const text = words.slice(timeWords).join(' ').trim() || config.scheduledPrompt
  await update($, scheduledAtom, () => ({ at, text }))
  armSchedule($, at, now)
  await showStatus($)
  return `已定时：${when(at)}（${span(at - now)}后）发送「${text}」。/auto-continue cancel 取消。`
}

async function clear($: EngineInterface) {
  timer?.cancel()
  timer = undefined
  await update($, waitAtom, () => null)
  await update($, limitedSince, () => null)
  await update($, attempts, () => 0)
  await showStatus($)
}

function arm($: EngineInterface, wait: AutoContinueWait, at: number) {
  timer?.cancel()
  timer = $.clock.after(Math.max(1000, wait.wakeAt - at), () => void fire($))
}

async function fire($: EngineInterface) {
  timer = undefined
  if (!(await isEnabled($)) || (await read($, waitAtom)) === null) return
  await update($, waitAtom, () => null)
  await update($, attempts, n => n + 1)
  await showStatus($)
  $.ui.toast('额度已刷新，自动继续')
  await $.prompt.submit({ text: config.prompt }).catch((err: unknown) => $.ui.toast(`自动继续没能发出消息：${String(err)}`))
}

// The quota ran out: wait for the window that holds it to reset, if that comes within the wait allowed.
async function plan($: EngineInterface) {
  if (!(await isEnabled($))) return
  const at = await $.clock.now()
  if ((await read($, attempts)) >= MAX_ATTEMPTS) {
    $.ui.toast(`自动继续了 ${MAX_ATTEMPTS} 次仍然受限，已停止等待`)
    await clear($)
    return
  }
  const since = (await read($, limitedSince)) ?? at
  await update($, limitedSince, () => since)
  const allowed = await maxWait($)

  const { rateLimits } = await $.session.usage()
  const used = rateLimits.filter(r => r.percentUsed >= 100)
  const out = used
    .filter(r => watched(r.kind) && r.resetsAt && !Number.isNaN(Date.parse(r.resetsAt)))
    .map(r => ({ kind: r.kind, resetAt: Date.parse(r.resetsAt as string) }))
    .sort((a, b) => b.resetAt - a.resetAt)[0]
  if (!out && used.length > 0 && !used.some(r => watched(r.kind))) {
    // only another window ran out, and only the weekly one is waited for
    await clear($)
    return
  }

  const wait: AutoContinueWait = out
    ? { wakeAt: Math.max(out.resetAt, at) + MARGIN_MS, kind: out.kind }
    : { wakeAt: at + POLL_MS, kind: null }
  if (wait.wakeAt > since + allowed) {
    const what = out ? `${label(out.kind)}要到 ${when(out.resetAt)} 才刷新` : '额度一直没有刷新'
    $.ui.toast(`${what}，超出允许的等待（${span(allowed)}），不再自动继续`, { timeoutMs: 10_000 })
    await clear($)
    return
  }
  await update($, waitAtom, () => wait)
  arm($, wait, at)
  await showStatus($)
  $.ui.toast(
    out ? `${label(out.kind)}用完了，${when(out.resetAt)} 刷新后自动继续` : `额度受限，${span(POLL_MS)}后自动再试`,
    { timeoutMs: 8000 },
  )
}

export const register: Register = (on, options) => {
  config = {
    isEnabledByDefault: Boolean(options.enabledByDefault),
    maxWaitMs: Math.max(0, Number(options.maxWaitHours ?? 24)) * HOUR,
    prompt: String(options.prompt ?? '').trim() || DEFAULT_PROMPT,
    scheduledPrompt: String(options.scheduledPrompt ?? '').trim() || DEFAULT_SCHEDULED_PROMPT,
    isWeeklyOnly: options.windows === 'seven_day',
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'auto-continue',
      description: '额度刷新后自动继续（on [时长] / off），或到点定时继续（at 14:30 / in 2h [消息]，cancel 取消）',
      argumentHint: '[on [1d] | off | at 14:30 [消息] | in 2h [消息] | cancel]',
    })
    // Settle the option's default into the state, so the quota bands that read it see on or off.
    if ((await read($, isEnabledAtom)) === null) await update($, isEnabledAtom, () => config.isEnabledByDefault)
    if ((await read($, maxWaitAtom)) === null) await update($, maxWaitAtom, () => config.maxWaitMs)
    // A reload, or a session resumed while waiting: arm the waits again.
    const now = await $.clock.now()
    const wait = await read($, waitAtom)
    if (wait && (await isEnabled($))) arm($, wait, now)
    const scheduled = await read($, scheduledAtom)
    if (scheduled) armSchedule($, scheduled.at, now)
    await showStatus($)
    return started
  })

  on('command.run', { command: 'auto-continue' }, async ($, e) => {
    const [verb = '', ...rest] = (e.args ?? '').trim().split(/\s+/).filter(Boolean)
    if (verb === 'off') {
      await update($, isEnabledAtom, () => false)
      await clear($)
      return { text: '自动继续已关闭。' }
    }
    if (verb === 'on' || parseSpan(verb) !== null) {
      const given = verb === 'on' ? rest.join(' ') : verb
      const ms = given ? parseSpan(given) : null
      if (given && ms === null) return { text: `看不懂时长「${given}」：写成 1d、12h、90m 这样。` }
      await update($, isEnabledAtom, () => true)
      if (ms !== null) await update($, maxWaitAtom, () => ms)
      await showStatus($)
      return { text: `自动继续已开启：额度用完后 ${span(await maxWait($))} 内刷新，就发送「${config.prompt}」。` }
    }
    if (verb === 'at' || verb === 'in') return { text: await schedule($, verb, rest) }
    if (verb === 'cancel') {
      const had = (await read($, scheduledAtom)) !== null
      await cancelSchedule($)
      return { text: had ? '已取消定时继续。' : '没有定时继续要取消。' }
    }
    if (verb) return { text: USAGE }

    const wait = await read($, waitAtom)
    const scheduled = await read($, scheduledAtom)
    const state = !(await isEnabled($))
      ? '额度自动继续：关'
      : wait
        ? `额度自动继续：开，正在等待，${when(wait.wakeAt)} 发送「${config.prompt}」`
        : `额度自动继续：开，额度用完后 ${span(await maxWait($))} 内刷新就继续`
    const timed = scheduled ? `定时继续：${when(scheduled.at)} 发送「${scheduled.text}」` : '定时继续：无'
    return { text: `${state}\n${timed}` }
  })

  // The main conversation stopped on a used-up quota.
  on('classic.StopFailure', async ($, e, next) => {
    const done = await next(e)
    if (e.error === 'rate_limit' && e.agent_id === undefined) await plan($).catch(() => undefined)
    return done
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    if (e.reason === 'answer' && ((await read($, limitedSince)) !== null || (await read($, attempts)) > 0)) {
      // the work carries on: the stretch is over
      await clear($)
    } else if (e.reason === 'error' && (await read($, waitAtom)) === null) {
      // in case StopFailure was not raised: an error while a watched window is used up
      const { rateLimits } = await $.session.usage()
      if (rateLimits.some(r => r.percentUsed >= 100 && watched(r.kind))) await plan($)
    }
    return done
  })

  // A mode label in the prompt footer while it is on (terminal and desktop).
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (!(await isEnabled($)) || e.props.modes.includes(MODE)) return next(e)
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, MODE] } })
  })
}
