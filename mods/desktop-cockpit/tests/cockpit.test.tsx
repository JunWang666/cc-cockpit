import { expect, test } from 'claude-code/testing'

const T0 = Date.parse('2026-10-21T10:00:00Z')
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 160 } } as const
const PANE = { component: 'Pane', requestId: 'desktop-cockpit', props: { title: '驾驶舱', isFocused: true, bodyColumns: 100 } } as const

const LIMITS = [
  { kind: 'five_hour', percentUsed: 68, resetsAt: '2026-10-21T11:12:00Z' },
  { kind: 'seven_day', percentUsed: 23.4, resetsAt: '2026-10-24T10:00:00Z' },
]

const GIT: Record<string, string> = {
  'rev-parse --is-inside-work-tree': 'true',
  'branch --show-current': 'main',
  'status --porcelain': ' M README.md\n',
  'rev-list --left-right --count @{upstream}...HEAD': '0\t2',
  'log -3 --format=%h%x09%ct%x09%s': `bfb6ee0\t${T0 / 1000 - 3600}\twelcome: show project docs`,
}

const transcript = [
  { type: 'user', message: { content: '上次：做个 band' } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'C:/work/mods/a.tsx' } }] } },
  { type: 'system', subtype: 'away_summary', content: '加了一个 band' },
]
  .map(r => JSON.stringify(r))
  .join('\n')

function engine(on: any) {
  on('clock.now', () => ({ value: T0 }))
  on('session.start', () => ({ cwd: 'C:/work' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('clock.every', () => ({ value: undefined }) as never)
  on('session.cwd', () => ({ value: 'C:/work' }))
  on('session.id', () => ({ value: 'self' }))
  on('session.turns', () => ({ value: 0 }))
  on('session.usage', () => ({ value: { startedAt: T0, context: { percent: 21 }, cost: { usd: 5.64 }, rateLimits: LIMITS } }) as never)
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    const [cmd, , , ...args] = e.argv
    const out = cmd === 'git' ? GIT[args.join(' ')] : cmd === 'cmd' ? 'C:/Users/me' : undefined
    return { value: { exitCode: out === undefined ? 1 : 0, stdout: out ?? '', stderr: '' } } as never
  })
  on('fs.list', (_$: unknown, e: { path?: string }) => ({
    value: !String(e.path).includes('.claude')
      ? [{ name: 'README.md', kind: 'file', size: 40, mtimeMs: T0, isLink: false }]
      : [
          { name: 'self.jsonl', kind: 'file', size: 10, mtimeMs: T0, isLink: false },
          { name: 'old.jsonl', kind: 'file', size: transcript.length, mtimeMs: T0 - 7200_000, isLink: false },
        ],
  }) as never)
  on('fs.exists', () => ({ value: false }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({
    value: e.path.endsWith('README.md') ? '# cc-cockpit\n\nClaude Code mods.\n' : transcript,
  }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.render', { component: 'AbovePrompt' }, ($$: any, e: any) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>below</Text>
  })
}

test('the desktop band: welcome card and stats row', async ($, on) => {
  engine(on)
  await $.session.start({ source: 'startup', cwd: 'C:/work' } as never)

  const ui = await $.ui.mount({ plugin: 'desktop-cockpit', surface: 'desktop', ...BAND } as never)
  for (const text of ['Turn', '$5.64', '68%', '23%', '21%', '上下文', 'C:/work', '最近提交', '加了一个 band', 'below']) {
    expect([text, (await ui.find({ type: 'Text', text })) !== undefined]).toEqual([text, true])
  }
  expect(await ui.find({ type: 'Text', text: /1 个未提交改动/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /README.md/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /上次：做个 band/ })).toBeDefined()
  await ui.press({ key: 'welcome-close' })
  expect(await ui.find({ type: 'Text', text: '最近提交' })).toBeUndefined()
  await ui.unmount()

  // narrow: still one line, with the total cost and long labels dropped
  const narrow = await $.ui.mount({ plugin: 'desktop-cockpit', surface: 'desktop', ...BAND, props: { ...BAND.props, bodyColumns: 70 } } as never)
  for (const text of ['#', 'ctx', '68%', '21%']) {
    expect([text, (await narrow.find({ type: 'Text', text })) !== undefined]).toEqual([text, true])
  }
  expect(await narrow.find({ type: 'Text', text: '$5.64' })).toBeUndefined()
  expect(await narrow.find({ type: 'Text', text: '上下文' })).toBeUndefined()
  await narrow.unmount()
})

test('the terminal band is left to quota-band and welcome', async ($, on) => {
  engine(on)
  await $.session.start({ source: 'startup', cwd: 'C:/work' } as never)
  const ui = await $.ui.mount({ plugin: 'desktop-cockpit', surface: 'terminal', ...BAND } as never)
  expect(await ui.find({ type: 'Text', text: 'below' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Turn' })).toBeUndefined()
})

test('the pane: usage, project and prompts tabs', async ($, on) => {
  engine(on)
  on('session.messages', () => ({
    value: [
      { role: 'user', text: '第一条：装个插件', toolUses: [] },
      { role: 'assistant', text: '好的', toolUses: [] },
      { role: 'user', text: '第二条：桌面版', toolUses: [] },
    ],
  }) as never)
  await $.session.start({ source: 'startup', cwd: 'C:/work' } as never)
  await $.command.run({ command: 'cockpit', args: '', origin: { kind: 'composer' }, presentation: {} } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'desktop-cockpit', surface, ...PANE } as never)
    expect(await ui.find({ type: 'Text', text: '输出速度' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1h12m后重置' })).toBeDefined()
    await ui.press({ key: 'tab-project' })
    expect(await ui.find({ type: 'Text', text: /main/ })).toBeDefined()
    await ui.press({ key: 'tab-prompts' })
    expect(await ui.find({ type: 'Text', text: /2 条消息/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'p2' })).toBeDefined()
    await ui.press({ key: 'tab-usage' })
    await ui.unmount()
  }
})

test('auto-continue sits beside the quota, and the pane runs its command', async ($, on) => {
  engine(on)
  const ran: string[] = []
  // auto-continue's state, as that mod would hold it
  const autoState: Record<string, unknown> = {}
  on('state.get', (_$: unknown, e: { plugin: string; key: string }, next: (e: unknown) => unknown) =>
    e.plugin === 'auto-continue' ? ({ value: { value: autoState[e.key], version: 1 } } as never) : next(e),
  )
  on('command.run', (_$: unknown, e: { command: string; args?: string }) => {
    ran.push(`${e.command} ${e.args ?? ''}`.trim())
    return { text: 'ok' } as never
  })
  await $.session.start({ source: 'startup', cwd: 'C:/work' } as never)

  // not installed: nothing drawn for it
  let ui = await $.ui.mount({ plugin: 'desktop-cockpit', surface: 'desktop', ...BAND } as never)
  expect(await ui.find({ type: 'Button', key: 'auto' })).toBeUndefined()
  await ui.unmount()

  autoState.isEnabled = true
  autoState.wait = { wakeAt: T0 + 2 * 3600_000, kind: 'seven_day' }
  ui = await $.ui.mount({ plugin: 'desktop-cockpit', surface: 'desktop', ...BAND } as never)
  expect(await ui.find({ type: 'Text', text: /⏳ .* 自动续/ })).toBeDefined()
  await ui.unmount()

  await $.command.run({ command: 'cockpit', args: 'usage', origin: { kind: 'composer' }, presentation: {} } as never)
  const pane = await $.ui.mount({ plugin: 'desktop-cockpit', surface: 'desktop', ...PANE } as never)
  expect(await pane.find({ type: 'Text', text: /周额度用完/ })).toBeDefined()
  await pane.press({ key: 'auto-toggle' })
  await pane.press({ key: 'auto-in-1h' })
  expect(ran).toEqual(['auto-continue off', 'auto-continue in 1h'])
})
