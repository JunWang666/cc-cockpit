import { expect, test } from 'claude-code/testing'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 120 } } as const
const NOW = Date.parse('2026-10-17T10:00:00Z')

const INFO = {
  git: { branch: 'main', changes: 2, ahead: 1, behind: 0, commits: [{ hash: 'abc1234', time: NOW - 3600_000, subject: 'Fix login' }] },
  sessions: [{ id: 'sess-1', prompt: '修一下登录页', prompts: 4, time: NOW - 7200_000 }],
  scannedAt: NOW,
}

test('shows the card at startup, resumes a session, hides on the first prompt', async ($, on) => {
  const filled: string[] = []
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.cwd', () => ({ value: '/work' }))
  on('session.id', () => ({ value: 'current' }))
  on('session.turns', () => ({ value: 0 }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(INFO), stderr: '' } }) as never)
  on('prompt.fill', (_$, e) => (filled.push(e.text), { isFilled: true }) as never)
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>below</Text>
  })

  await $.session.start({ source: 'startup', cwd: '/work' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'welcome', surface, ...BAND } as never)
    for (const text of ['/work', '最近提交', 'abc1234', 'below']) {
      expect([text, (await ui.find({ type: 'Text', text })) !== undefined]).toEqual([text, true])
    }
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'welcome', surface: 'terminal', ...BAND } as never)
  await ui.press({ key: 'sess-1' })
  expect(filled).toEqual(['/resume sess-1'])
  expect(await ui.find({ type: 'Text', text: '最近提交' })).toBeUndefined()

  await $.command.run({ command: 'welcome', args: '', origin: { kind: 'composer' }, presentation: {} } as never)
  expect(await ui.find({ type: 'Text', text: '最近提交' })).toBeDefined()
  await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' } } as never)
  expect(await ui.find({ type: 'Text', text: '最近提交' })).toBeUndefined()
})

test('stays hidden in a resumed session', async ($, on) => {
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.turns', () => ({ value: 7 }))
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>below</Text>
  })
  await $.session.start({ cwd: '/work' } as never)
  const ui = await $.ui.mount({ plugin: 'welcome', surface: 'terminal', ...BAND } as never)
  expect(await ui.find({ type: 'Text', text: '最近提交' })).toBeUndefined()
})
