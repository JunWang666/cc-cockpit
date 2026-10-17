import { expect, test } from 'claude-code/testing'

const PANE = { component: 'Pane', requestId: 'prompt-jump', props: { title: '我的消息', isFocused: true, bodyColumns: 100 } } as const
const row = (text: string) => ({ text, origin: { kind: 'composer' }, isExpanded: false }) as never

test('lists my prompts newest first and scrolls to one', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.render', { component: 'UserMessage' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>row</Text>
  })
  on('session.messages', () => ({
    value: [
      { role: 'user', text: '第一条：装个插件', toolUses: [] },
      { role: 'assistant', text: '好的', toolUses: [] },
      { role: 'user', text: '', toolUses: [], toolResults: [] },
      { role: 'user', text: '<task-notification>done</task-notification>', toolUses: [] },
      { role: 'user', text: '第二条：配置飞书', toolUses: [] },
    ],
  }) as never)

  // the transcript draws the first prompt's row only
  await $.ui.mount({ plugin: 'prompt-jump', surface: 'terminal', component: 'UserMessage', requestId: 'msg-1', props: row('第一条：装个插件') })
  await $.command.run({ command: 'prompts', args: '', origin: { kind: 'composer' }, presentation: {} } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'prompt-jump', surface, ...PANE })
    const buttons = await ui.findAll({ type: 'Button' })
    expect(buttons).toHaveLength(3)
    expect(await ui.find({ type: 'Text', text: /2 条消息/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'prompt-jump', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: / ·未加载/ })).toBeDefined()
  await ui.press({ key: 'p1' })
  await ui.press({ key: 'p2' })
  await ui.press({ key: 'bottom' })
})
