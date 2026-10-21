import { expect, mock, test } from 'claude-code/testing'

const T0 = Date.parse('2026-10-21T10:00:00Z')
const HOUR = 60 * 60 * 1000

const run = (args: string) => ({ command: 'auto-continue', args, origin: { kind: 'composer' }, presentation: {} }) as never

function engine(on: any, resetIn: number) {
  const clock = mock.clock(on, { now: T0 })
  const sent: string[] = []
  const toasts: string[] = []
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.usage', () => ({
    value: {
      startedAt: T0,
      context: { percent: 40 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 12, resetsAt: new Date(T0 + 3 * HOUR).toISOString() },
        { kind: 'seven_day', percentUsed: 100, resetsAt: new Date(T0 + resetIn).toISOString() },
      ],
    },
  }) as never)
  on('prompt.submit', (_$: unknown, e: { text: string }) => {
    sent.push(e.text)
    return { text: e.text } as never
  })
  on('ui.toast', (_$: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  on('ui.status', () => ({ value: undefined }) as never)
  on('classic.StopFailure', () => ({}) as never)
  return { clock, sent, toasts }
}

const limited = { error: 'rate_limit' } as never

test('waits for the weekly reset within the day and carries on', async ($, on) => {
  const { clock, sent, toasts } = engine(on, 10 * HOUR)
  await $.session.start({ source: 'startup', cwd: '/work' } as never)
  const opened = await $.command.run(run('on 1d'))
  expect((opened as { text: string }).text).toMatch(/1 天/)

  await $.classic.StopFailure(limited)
  expect(toasts.some(t => /周额度用完了/.test(t))).toBe(true)
  expect((await $.command.run(run(''))) as { text: string }).toEqual({ text: expect.stringMatching(/正在等待/) })

  await clock.advance(10 * HOUR)
  expect(sent).toEqual([])
  await clock.advance(3 * 60 * 1000)
  expect(sent).toEqual(['额度已刷新，请从中断的地方继续完成刚才的任务。'])
})

test('a reset past the wait allowed is not waited for', async ($, on) => {
  const { clock, sent, toasts } = engine(on, 3 * 24 * HOUR)
  await $.session.start({ source: 'startup', cwd: '/work' } as never)
  await $.command.run(run('on 1d'))
  await $.classic.StopFailure(limited)
  expect(toasts.some(t => /超出允许的等待/.test(t))).toBe(true)
  await clock.advance(4 * 24 * HOUR)
  expect(sent).toEqual([])
})

test('off by default, and off stops a wait', async ($, on) => {
  const { clock, sent } = engine(on, 2 * HOUR)
  await $.session.start({ source: 'startup', cwd: '/work' } as never)
  await $.classic.StopFailure(limited)
  await clock.advance(3 * HOUR)
  expect(sent).toEqual([])

  await $.command.run(run('on'))
  await $.classic.StopFailure(limited)
  await $.command.run(run('off'))
  await clock.advance(3 * HOUR)
  expect(sent).toEqual([])
})

test('the prompt and the wait come from the options', { options: { enabledByDefault: true, maxWaitHours: 1, prompt: 'go on' } }, async ($, on) => {
  const { clock, sent } = engine(on, 30 * 60 * 1000)
  await $.session.start({ source: 'startup', cwd: '/work' } as never)
  await $.classic.StopFailure(limited)
  await clock.advance(HOUR)
  expect(sent).toEqual(['go on'])
})
