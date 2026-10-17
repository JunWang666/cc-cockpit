import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const PANE = 'prompt-jump'
const HOTKEYS = '123456789abcdefghijklmnopqrstuvwxyz'
const filter = atom({ plugin: 'prompt-jump', key: 'filter' } as const, '')

// Transcript rows of the person's prompts, in the order the transcript drew them.
// A render hook may not write $.state, so this lives in the module.
const drawn: { requestId: string; text: string }[] = []
// Every transcript row drawn so far, and the newest one first drawn since the last prompt: the bottom.
const seenRows = new Set<string>()
let isLive = false
let bottomRow: string | undefined

const isOwnPrompt = (text: string) => text.trim() !== '' && !text.trimStart().startsWith('<')

function noteRow(requestId: string) {
  if (seenRows.has(requestId)) return
  seenRows.add(requestId)
  if (isLive) bottomRow = requestId
}

async function scrollTo($: EngineInterface, requestId: string, block: 'start' | 'end') {
  const moved = await $.ui
    .scroll({ to: { requestId }, block })
    .catch((err: unknown) => ({ deny: String(err) }))
  if (moved.deny) $.ui.toast(`没法滚动过去：${moved.deny}（对话区需在全屏模式 /tui fullscreen）`)
}

async function scrollToBottom($: EngineInterface) {
  if (!bottomRow) {
    $.ui.toast('还不知道底部在哪：发一条消息后再试')
    return
  }
  await scrollTo($, bottomRow, 'end')
}

const oneLine = (text: string, width: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > width ? flat.slice(0, width - 1) + '…' : flat
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'prompts',
      description: '列出本会话里你发过的消息，按编号跳到那条（可加关键词过滤）',
      argumentHint: '[关键词]',
    })
    await $.command.register({ name: 'bottom', description: '对话区跳回最底部' })
    return next(e)
  })

  on('command.run', { command: 'bottom' }, async $ => {
    await scrollToBottom($)
    return { text: '' }
  })

  on('prompt.submit', ($, e, next) => {
    isLive = true
    return next(e)
  })

  on('ui.render', { component: 'UserMessage' }, ($, e, next) => (noteRow(e.requestId), next(e)))
  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => (noteRow(e.requestId), next(e)))
  on('ui.render', { component: 'ToolUse' }, ($, e, next) => (noteRow(e.requestId), next(e)))
  on('ui.render', { component: 'ToolResult' }, ($, e, next) => (noteRow(e.requestId), next(e)))

  on('command.run', { command: 'prompts' }, async ($, e) => {
    await update($, filter, () => (e.args ?? '').trim())
    const opened = await $.ui.open({ id: PANE, title: '我的消息', focus: true, closeOnEscape: true })
    return { text: opened.isPlaced ? '已打开消息列表。' : `消息列表暂时无法显示：${opened.reason}` }
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const kind = e.props.origin.kind
    const isPerson = kind !== 'task-notification' && kind !== 'plugin' && !e.props.from
    if (isPerson && isOwnPrompt(e.props.text) && !drawn.some(d => d.requestId === e.requestId)) {
      drawn.push({ requestId: e.requestId, text: e.props.text })
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const query = (await read($, filter)).toLowerCase()
    const messages = await $.session.messages()

    // The session's own prompts, matched in order to the transcript rows drawn so far.
    const pool = [...drawn]
    const prompts = messages
      .filter(m => m.role === 'user' && isOwnPrompt(m.text))
      .map((m, i) => {
        const at = pool.findIndex(d => d.text.trim() === m.text.trim())
        const requestId = at >= 0 ? pool.splice(at, 1)[0]?.requestId : undefined
        return { n: i + 1, text: m.text, requestId }
      })
      .filter(p => !query || p.text.toLowerCase().includes(query))
      .reverse()

    const width = Math.max(20, (e.props.bodyColumns || e.viewport?.columns || 80) - 12)

    const jump = async (requestId: string | undefined) => {
      if (!requestId) {
        $.ui.toast('这条还没在对话区加载过：往上滚动经过它一次后就能跳了')
        return
      }
      await scrollTo($, requestId, 'start')
    }

    return (
      <Box flexDirection="column">
        <Text dimColor>
          {query ? `过滤「${query}」· ` : ''}
          {prompts.length} 条消息，最新的在上 · 按编号跳转，0 回到底部，Esc 关闭
        </Text>
        <Button key="bottom" plain hotkey="0" onPress={() => scrollToBottom($)}>
          ↓ 回到底部
        </Button>
        {prompts.length === 0 && <Text dimColor>还没有消息。</Text>}
        {prompts.map((p, i) => (
          <Button key={`p${p.n}`} plain hotkey={HOTKEYS[i]} onPress={() => jump(p.requestId)}>
            <Text dimColor>#{p.n} </Text>
            {oneLine(p.text, width)}
            {p.requestId ? '' : <Text dimColor> ·未加载</Text>}
          </Button>
        ))}
      </Box>
    )
  })
}
