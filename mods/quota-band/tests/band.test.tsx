import { expect, test } from 'claude-code/testing'

const band = (bodyColumns: number) =>
  ({ component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns } }) as const

const T0 = Date.parse('2026-10-17T10:00:00Z')

const usage = (rateLimits: unknown[]) => ({
  value: {
    startedAt: T0,
    context: { percent: 21 },
    cost: { usd: 5.64 },
    rateLimits,
  },
})

const LIMITS = [
  { kind: 'five_hour', percentUsed: 68, resetsAt: '2026-10-17T11:12:00Z' },
  { kind: 'seven_day', percentUsed: 23.4, resetsAt: '2026-10-20T10:00:00Z' },
]

test('one row: turn, speed, cost, cache, quota and context', async ($, on) => {
  on('clock.now', () => ({ value: T0 }))
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('session.turns', () => ({ value: 6 }))
  on('session.usage', () => usage(LIMITS) as never)
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>below</Text>
  })

  await $.session.start({ source: 'startup', cwd: '/work' } as never)

  for (const surface of ['terminal'] as const) {
    const ui = await $.ui.mount({ plugin: 'quota-band', surface, ...band(160) } as never)
    for (const text of ['Turn', '6', '$5.64', '68%', '23%', '1h12m后重置', '3天后重置', '上下文', '21%', 'below']) {
      expect([text, (await ui.find({ type: 'Text', text })) !== undefined]).toEqual([text, true])
    }
    expect(await ui.find({ type: 'Text', text: /^━+$/ })).toBeDefined()
    await ui.unmount()
  }

  // the desktop draws desktop-cockpit's band instead
  const desk = await $.ui.mount({ plugin: 'quota-band', surface: 'desktop', ...band(160) } as never)
  expect(await desk.find({ type: 'Text', text: 'Turn' })).toBeUndefined()
  expect(await desk.find({ type: 'Text', text: 'below' })).toBeDefined()
  await desk.unmount()

  // narrow: bars and reset times go, percents stay
  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...band(90) } as never)
  expect(await ui.find({ type: 'Text', text: '68%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1h12m后重置' })).toBeUndefined()
})

test('divider and stats still draw with no quota data', async ($, on) => {
  on('session.turns', () => ({ value: 0 }))
  on('session.usage', () => usage([]) as never)
  on('clock.now', () => ({ value: 0 }))
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Box } = $$.ui.resolve(e)
    return <Box />
  })
  const ui = await $.ui.mount({ plugin: 'quota-band', surface: 'terminal', ...band(120) } as never)
  expect(await ui.find({ type: 'Text', text: /^━+$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '5h' })).toBeUndefined()
})
