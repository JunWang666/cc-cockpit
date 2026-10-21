import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AutoContinueWait } from '../types'

const isEnabledAtom = atom({ plugin: 'auto-continue', key: 'isEnabled' } as const, null)
const maxWaitAtom = atom({ plugin: 'auto-continue', key: 'maxWaitMs' } as const, null)
const limitedSince = atom({ plugin: 'auto-continue', key: 'limitedSince' } as const, null)
const waitAtom = atom({ plugin: 'auto-continue', key: 'wait' } as const, null)
const attempts = atom({ plugin: 'auto-continue', key: 'attempts' } as const, 0)

const HOUR = 60 * 60 * 1000
// Sent a little after the reset, so the new window is surely open.
const MARGIN_MS = 2 * 60 * 1000
// With no reset time reported, try again this often until the wait allowed runs out.
const POLL_MS = 30 * 60 * 1000
// Prompts sent in a row that hit the limit again before giving up.
const MAX_ATTEMPTS = 3
const MODE = 'auto-continue'
const DEFAULT_PROMPT = '额度已刷新，请从中断的地方继续完成刚才的任务。'
const LABELS: Record<string, string> = { five_hour: '5 小时额度', seven_day: '周额度', spend_limit: '花费额度' }

// The manifest's options, read once per load by register.
let config = { isEnabledByDefault: false, maxWaitMs: 24 * HOUR, prompt: DEFAULT_PROMPT, isWeeklyOnly: false }
// The module's own timer: a reload drops it, and session.start arms it again from $.state.
let timer: Timer | undefined

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

async function isEnabled($: EngineInterface) {
  return (await read($, isEnabledAtom)) ?? config.isEnabledByDefault
}

async function maxWait($: EngineInterface) {
  return (await read($, maxWaitAtom)) ?? config.maxWaitMs
}

async function showStatus($: EngineInterface) {
  const wait = await read($, waitAtom)
  if (wait && (await isEnabled($))) $.ui.status(`⏳ ${label(wait.kind)}用完 · ${when(wait.wakeAt)} 自动继续`)
  else $.ui.status(undefined)
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
    isWeeklyOnly: options.windows === 'seven_day',
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'auto-continue',
      description: '额度用完后，在允许的等待时间内刷新就自动继续：on [时长] / off / 不带参数看状态',
      argumentHint: '[on [1d|12h|90m] | off]',
    })
    // A reload, or a session resumed while waiting: arm the wait again.
    const wait = await read($, waitAtom)
    if (wait && (await isEnabled($))) arm($, wait, await $.clock.now())
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
    if (verb) return { text: '用法：/auto-continue on [1d|12h|90m]，/auto-continue off，不带参数看状态。' }

    const wait = await read($, waitAtom)
    const state = !(await isEnabled($))
      ? '自动继续：关'
      : wait
        ? `自动继续：开，正在等待，${when(wait.wakeAt)} 发送「${config.prompt}」`
        : `自动继续：开，额度用完后 ${span(await maxWait($))} 内刷新就继续`
    return { text: state }
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
