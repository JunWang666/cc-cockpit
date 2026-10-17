import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { WelcomeInfo } from '../types'

const info = atom({ plugin: 'welcome', key: 'info' } as const, null)
const isShown = atom({ plugin: 'welcome', key: 'isShown' } as const, false)

const SESSIONS = 5
const ACCENT = '#5fa8d3'

const ago = (ms: number, now: number) => {
  const min = Math.max(0, Math.round((now - ms) / 60000))
  if (min < 60) return `${min}分钟前`
  const h = Math.round(min / 60)
  if (h < 24) return `${h}小时前`
  return `${Math.round(h / 24)}天前`
}

const cut = (text: string, width: number) => (text.length > width ? text.slice(0, Math.max(1, width - 1)) + '…' : text)

async function scan($: EngineInterface) {
  const cwd = await $.session.cwd()
  const self = await $.session.id()
  const ran = await $.process
    .run(['python3', `${$.plugin.root}/hooks/scan.py`, cwd, self, String(SESSIONS)], { timeoutMs: 15000 })
    .catch(() => null)
  if (!ran || ran.exitCode !== 0) return
  const found: WelcomeInfo = JSON.parse(ran.stdout)
  await update($, info, () => found)
}

async function show($: EngineInterface) {
  await update($, isShown, () => true)
  await scan($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'welcome', description: '重新显示欢迎卡片：项目状态和最近会话' })
    // A fresh session (a new launch, or /clear): no prompts yet; a resumed one has some.
    if ((await $.session.turns()) === 0) await show($)
    return started
  })

  on('command.run', { command: 'welcome' }, async $ => {
    await show($)
    return { text: '' }
  })

  // The card steps aside once the conversation starts.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer') await update($, isShown, () => false)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const found = await read($, info)
    if (e.props.hasSurvey || !(await read($, isShown)) || found === null) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const cwd = await $.session.cwd()
    const now = found.scannedAt
    const width = Math.max(20, e.props.bodyColumns - 30)
    const git = found.git

    const resume = async (id: string) => {
      await update($, isShown, () => false)
      await $.prompt.fill({ text: `/resume ${id}` })
      $.ui.toast('按回车回到这个会话')
    }

    const card = (
      <Box key="welcome" flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
        <Box flexDirection="row" columnGap={2}>
          <Text bold color={ACCENT}>{cwd}</Text>
          {git ? (
            <Text>
              ⎇ {git.branch}
              {git.changes > 0 ? <Text color="yellow">{`  ${git.changes} 个未提交改动`}</Text> : <Text dimColor>  工作区干净</Text>}
              {git.ahead ? <Text color="green">{`  ↑${git.ahead}`}</Text> : null}
              {git.behind ? <Text color="red">{`  ↓${git.behind}`}</Text> : null}
            </Text>
          ) : (
            <Text dimColor>不是 git 仓库</Text>
          )}
          <Box flexGrow={1} />
          <Button key="close" label="×" plain role="dismiss" onPress={() => update($, isShown, () => false)} />
        </Box>
        {git && git.commits.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>最近提交</Text>
            {git.commits.map(c => (
              <Text key={c.hash}>
                <Text color="yellow">{c.hash}</Text> {cut(c.subject, width)} <Text dimColor>{ago(c.time, now)}</Text>
              </Text>
            ))}
          </Box>
        ) : null}
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{found.sessions.length > 0 ? '最近会话 · 在空输入框按数字键接着聊' : '这个项目还没有别的会话'}</Text>
          {found.sessions.map((s, i) => (
            <Button key={s.id} plain hotkey={String(i + 1)} onPress={() => resume(s.id)}>
              {cut(s.prompt, width)} <Text dimColor>{`· ${s.prompts}条 · ${ago(s.time, now)}`}</Text>
            </Button>
          ))}
        </Box>
      </Box>
    )

    const below = await next(e)
    return (
      <Box flexDirection="column">
        {card}
        {below}
      </Box>
    )
  })
}
