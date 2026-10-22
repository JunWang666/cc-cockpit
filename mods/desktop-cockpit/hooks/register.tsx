import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CockpitDoc, CockpitGit, CockpitProject, CockpitSession, CockpitStats, CockpitTab, CockpitWindow } from '../types'

const PANE = 'desktop-cockpit'

const stats = atom({ plugin: 'desktop-cockpit', key: 'stats' } as const, {
  turn: 0,
  speed: null,
  turnCost: null,
  total: 0,
  costAtStart: 0,
  context: 0,
} as CockpitStats)
const windows = atom({ plugin: 'desktop-cockpit', key: 'windows' } as const, [])
const cacheExpiresAt = atom({ plugin: 'desktop-cockpit', key: 'cacheExpiresAt' } as const, null)
const now = atom({ plugin: 'desktop-cockpit', key: 'now' } as const, 0)
const project = atom({ plugin: 'desktop-cockpit', key: 'project' } as const, null)
const isWelcomeShown = atom({ plugin: 'desktop-cockpit', key: 'isWelcomeShown' } as const, false)
const openDoc = atom({ plugin: 'desktop-cockpit', key: 'openDoc' } as const, null)
const tab = atom({ plugin: 'desktop-cockpit', key: 'tab' } as const, 'usage' as CockpitTab)
const filter = atom({ plugin: 'desktop-cockpit', key: 'filter' } as const, '')
// The auto-continue mod's state, read only: absent when it is not installed.
const autoOn = atom({ plugin: 'auto-continue', key: 'isEnabled' } as const, null)
const autoWait = atom({ plugin: 'auto-continue', key: 'wait' } as const, null)
const autoScheduled = atom({ plugin: 'auto-continue', key: 'scheduled' } as const, null)
const autoMaxWait = atom({ plugin: 'auto-continue', key: 'maxWaitMs' } as const, null)
const autoMessage = atom({ plugin: 'desktop-cockpit', key: 'autoMessage' } as const, '')

const TABS: { id: CockpitTab; label: string }[] = [
  { id: 'usage', label: '用量' },
  { id: 'project', label: '项目' },
  { id: 'prompts', label: '我的消息' },
]
const LABELS: Record<string, string> = { five_hour: '5h', seven_day: '周', spend_limit: '花费' }

const ACCENT = '#5fa8d3'
const SPEED = '#8b8cf8'
const MONEY = '#4caf6e'
const CACHE = '#4fb3a9'
const WARN = '#e2a94e'
const ALERT = '#e0846b'
const TRACK = '#8a8a8a40'

// Output speed: ignore replies too short or too quick to time fairly.
const MIN_TOKENS = 20
const MIN_SECONDS = 0.5
const MAX_SPEED = 1000

// The prompt cache lives an hour after the last answer. The desktop shows it in minutes,
// so the clock ticks slowly: each tick is a redraw sent over the wire.
const CACHE_TTL_MS = 60 * 60 * 1000
const CACHE_WARN_MIN = 20
const CACHE_ALERT_MIN = 10
const TICK_MS = 15_000

// Narrower than these, the band's one line drops its quota bars, then its total cost and long labels.
const DESK_FULL_COLUMNS = 120
const DESK_MID_COLUMNS = 85

const SESSIONS = 5
const EDITED_SHOWN = 5
const DOCS = ['README.md', 'AGENTS.md', 'CLAUDE.md']
const PREVIEW_LINES = 12
// $.fs.read refuses files over 4 MiB; a transcript that large is left out of the list.
const MAX_TRANSCRIPT = 4 * 1024 * 1024

const level = (pct: number) => (pct >= 80 ? ALERT : pct >= 50 ? WARN : MONEY)
const usd = (n: number) => `$${n.toFixed(2)}`
const cut = (text: string, width: number) => (text.length > width ? text.slice(0, Math.max(1, width - 1)) + '…' : text)
const oneLine = (text: string, width: number) => cut(text.replace(/\s+/g, ' ').trim(), width)

const bar = (pct: number, color: string, width = 64, height = 6) => {
  const fill = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" rx="${height / 2}" fill="${TRACK}"/>` +
    `<rect width="${fill}" height="${height}" rx="${height / 2}" fill="${color}"/></svg>`
  )
}

const ago = (ms: number, at: number) => {
  const min = Math.max(0, Math.round((at - ms) / 60000))
  if (min < 60) return `${min}分钟前`
  const h = Math.round(min / 60)
  if (h < 24) return `${h}小时前`
  return `${Math.round(h / 24)}天前`
}

const resetIn = (resetsAt: string | undefined, at: number) => {
  if (!resetsAt) return ''
  const min = Math.max(0, Math.round((Date.parse(resetsAt) - at) / 60000))
  if (Number.isNaN(min)) return ''
  if (min < 60) return `${min}分钟后重置`
  if (min < 24 * 60) return `${Math.floor(min / 60)}h${min % 60}m后重置`
  return `${Math.round(min / 1440)}天后重置`
}

// ── usage ────────────────────────────────────────────────────────────────

async function refresh($: EngineInterface) {
  const { rateLimits, cost, context } = await $.session.usage()
  const list: CockpitWindow[] = rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt }))
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

// ── project scan (git, docs, recent sessions), in place of the welcome mod's scan.py ──

const slash = (path: string) => path.replace(/\\/g, '/')

async function git($: EngineInterface, cwd: string, ...args: string[]) {
  const ran = await $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 5000 }).catch(() => null)
  return ran && ran.exitCode === 0 ? ran.stdout.trim() : null
}

async function gitState($: EngineInterface, cwd: string): Promise<CockpitGit | null> {
  if ((await git($, cwd, 'rev-parse', '--is-inside-work-tree')) !== 'true') return null
  const branch = (await git($, cwd, 'branch', '--show-current')) || (await git($, cwd, 'rev-parse', '--short', 'HEAD')) || '?'
  const status = (await git($, cwd, 'status', '--porcelain')) ?? ''
  let ahead: number | null = null
  let behind: number | null = null
  const counts = await git($, cwd, 'rev-list', '--left-right', '--count', '@{upstream}...HEAD')
  if (counts) [behind, ahead] = counts.split(/\s+/).map(Number) as [number, number]
  const log = (await git($, cwd, 'log', '-3', '--format=%h%x09%ct%x09%s')) ?? ''
  const commits = log
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [hash = '', ct = '', subject = ''] = line.split('\t')
      return { hash, time: /^\d+$/.test(ct) ? Number(ct) * 1000 : 0, subject }
    })
  return { branch, changes: status.split('\n').filter(l => l.trim()).length, ahead, behind, commits }
}

async function docs($: EngineInterface, cwd: string): Promise<CockpitDoc[]> {
  const entries = await $.fs.list(cwd).catch(() => [])
  const names = new Map(entries.map(e => [e.name.toLowerCase(), e.name]))
  const out: CockpitDoc[] = []
  for (const want of DOCS) {
    let name = names.get(want.toLowerCase())
    if (!name && want === 'CLAUDE.md' && (await $.fs.exists(`${cwd}/.claude/CLAUDE.md`))) name = '.claude/CLAUDE.md'
    if (!name) continue
    const text = await $.fs.read(`${cwd}/${name}`).catch(() => null)
    if (text === null) continue
    const lines = text.split(/\r?\n/)
    let title = ''
    let gist = ''
    const preview: string[] = []
    for (const raw of lines) {
      const line = raw.trim()
      // badges, html, image-only and rule lines say nothing in a card
      if (!line || /^(<|!\[|\[!\[|---|===)/.test(line)) continue
      if (preview.length < PREVIEW_LINES) preview.push(raw.trimEnd())
      if (!title && line.startsWith('#')) title = line.replace(/^#+/, '').trim()
      else if (!gist && !/^(#|\||```|>)/.test(line)) gist = line.replace(/[*_`]/g, '')
      if (title && gist && preview.length >= PREVIEW_LINES) break
    }
    out.push({ name, title, gist: gist.slice(0, 300), lines: lines.length, preview })
  }
  return out
}

// The folder that holds ~/.claude: read off the mod's own path when it is under it, else asked of the shell.
async function homeDir($: EngineInterface) {
  const root = slash($.plugin.root)
  const at = root.indexOf('/.claude/')
  if (at >= 0) return root.slice(0, at)
  for (const argv of [['cmd', '/c', 'echo %USERPROFILE%'], ['sh', '-c', 'echo $HOME']]) {
    const ran = await $.process.run(argv, { timeoutMs: 5000 }).catch(() => null)
    const out = ran?.exitCode === 0 ? ran.stdout.trim() : ''
    if (out && !out.includes('%')) return slash(out)
  }
  return null
}

type Block = { type?: string; text?: string; name?: string; input?: Record<string, unknown> }

const promptText = (content: unknown) => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) for (const b of content as Block[]) if (b?.type === 'text') return b.text ?? ''
  return ''
}

async function sessions($: EngineInterface, cwd: string, self: string): Promise<CockpitSession[]> {
  const home = await homeDir($)
  if (!home) return []
  const folder = `${home}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}`
  const files = (await $.fs.list(folder).catch(() => []))
    .filter(f => f.kind === 'file' && f.name.endsWith('.jsonl') && f.name.slice(0, -6) !== self)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  const base = slash(cwd).replace(/\/+$/, '') + '/'
  const out: CockpitSession[] = []
  for (const file of files) {
    if (out.length >= SESSIONS) break
    if (file.size > MAX_TRANSCRIPT) continue
    const text = await $.fs.read(`${folder}/${file.name}`).catch(() => null)
    if (text === null) continue
    const isLatest = out.length === 0
    let first = ''
    let count = 0
    let recap = ''
    const edited: string[] = []
    for (const line of text.split('\n')) {
      const isRecap = line.includes('"away_summary"')
      const isEdit = isLatest && line.includes('"tool_use"')
      if (!line.includes('"type":"user"') && !isRecap && !isEdit) continue
      let row: Record<string, any>
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (isRecap && row.subtype === 'away_summary') {
        recap = String(row.content ?? '')
        continue
      }
      if (isEdit && row.type === 'assistant' && !row.isSidechain) {
        for (const b of (row.message?.content ?? []) as Block[]) {
          if (b?.type !== 'tool_use' || !['Edit', 'Write', 'NotebookEdit'].includes(b.name ?? '')) continue
          const fp = slash(String(b.input?.file_path ?? b.input?.notebook_path ?? ''))
          const rel = fp.startsWith(base) ? fp.slice(base.length) : fp
          if (rel && !edited.includes(rel)) edited.push(rel)
        }
        continue
      }
      if (row.type !== 'user' || row.isSidechain || row.isMeta || row.toolUseResult !== undefined) continue
      const said = promptText(row.message?.content).trim()
      if (!said || said.startsWith('<')) continue
      count += 1
      first = first || said.replace(/\s+/g, ' ')
    }
    if (!first) continue
    const found: CockpitSession = { id: file.name.slice(0, -6), prompt: first.slice(0, 200), prompts: count, time: file.mtimeMs }
    if (isLatest) {
      // the latest session also says what it did: its last recap and the files it edited
      found.recap = recap.replace(/\s*\(disable recaps in \/config\)\s*$/, '').trim().slice(0, 600)
      found.edited = edited
    }
    out.push(found)
  }
  return out
}

async function scan($: EngineInterface) {
  const cwd = slash(await $.session.cwd())
  const self = await $.session.id()
  const [g, d, s] = await Promise.all([gitState($, cwd), docs($, cwd), sessions($, cwd, self)])
  const found: CockpitProject = { git: g, docs: d, sessions: s, scannedAt: await $.clock.now() }
  await update($, project, () => found)
}

// ── prompts: the transcript rows of the person's own messages, to scroll to ──

// A render hook may not write $.state, so these live in the module.
const drawn: { requestId: string; text: string }[] = []
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
  const moved = await $.ui.scroll({ to: { requestId }, block }).catch((err: unknown) => ({ deny: String(err) }))
  if (moved.deny) $.ui.toast(`没法滚动过去：${moved.deny}`)
}

async function scrollToBottom($: EngineInterface) {
  if (!bottomRow) {
    $.ui.toast('还不知道底部在哪：发一条消息后再试')
    return
  }
  await scrollTo($, bottomRow, 'end')
}

// ── auto-continue, shown beside the quota: its state is read here, changed through its own command ──

const AUTO_LABELS: Record<string, string> = { five_hour: '5 小时额度', seven_day: '周额度', spend_limit: '花费额度' }

// `14:30` today, `10/22 14:30` on another day.
const clockTime = (ms: number, at: number) => {
  const d = new Date(ms)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return d.toDateString() === new Date(at).toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

async function runAuto($: EngineInterface, args: string) {
  const ran = await $.command.run({ command: 'auto-continue', args }).catch((err: unknown) => ({ text: `没能执行 /auto-continue：${String(err)}` }))
  if (ran.text) $.ui.toast(ran.text)
}

async function openPane($: EngineInterface, to?: CockpitTab) {
  if (to) await update($, tab, () => to)
  if ((await read($, tab)) === 'project' && (await read($, project)) === null) await scan($)
  return $.ui.open({ id: PANE, title: '驾驶舱', focus: true, closeOnEscape: true })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'cockpit',
      description: '打开驾驶舱面板：用量、项目状态、本会话你发过的消息',
      argumentHint: '[usage|project|prompts] [关键词]',
    })
    await refresh($)
    $.clock.every(TICK_MS, async () => {
      const at = await $.clock.now()
      await update($, now, () => at)
    })
    $.clock.every(60_000, () => refresh($))
    await scan($)
    // A fresh session (a new launch, or /clear): no prompts yet; a resumed one has some.
    if ((await $.session.turns()) === 0) await update($, isWelcomeShown, () => true)
    return started
  })

  on('command.run', { command: 'cockpit' }, async ($, e) => {
    const [first = '', ...rest] = (e.args ?? '').trim().split(/\s+/)
    const named = TABS.find(t => t.id === first)?.id
    const keyword = (named ? rest.join(' ') : (e.args ?? '')).trim()
    await update($, filter, () => keyword)
    const opened = await openPane($, named ?? (keyword ? 'prompts' : undefined))
    return { text: opened.isPlaced ? '已打开驾驶舱。' : `驾驶舱暂时无法显示：${opened.reason}` }
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

  // The welcome card steps aside once the conversation starts.
  on('prompt.submit', async ($, e, next) => {
    isLive = true
    if (e.origin.kind === 'composer') await update($, isWelcomeShown, () => false).catch(() => undefined)
    return next(e)
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    noteRow(e.requestId)
    const kind = e.props.origin.kind
    const isPerson = kind !== 'task-notification' && kind !== 'plugin' && !e.props.from
    if (isPerson && isOwnPrompt(e.props.text) && !drawn.some(d => d.requestId === e.requestId)) {
      drawn.push({ requestId: e.requestId, text: e.props.text })
    }
    return next(e)
  })
  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => (noteRow(e.requestId), next(e)))
  on('ui.render', { component: 'ToolUse' }, ($, e, next) => (noteRow(e.requestId), next(e)))
  on('ui.render', { component: 'ToolResult' }, ($, e, next) => (noteRow(e.requestId), next(e)))

  // ── the band above the prompt: the desktop's alone; the terminal keeps quota-band and welcome ──

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'desktop' || e.props.hasSurvey) return next(e)
    isTinted = true
    const { Box, Text, Button, Svg, Markdown } = $.ui.resolve(e)
    const s = await read($, stats)
    const list = await read($, windows)
    const expiresAt = await read($, cacheExpiresAt)
    const at = await read($, now)

    const left = expiresAt === null || at === 0 ? null : Math.max(0, Math.ceil((expiresAt - at) / 60000))
    const cacheColor =
      e.props.isWorking || left === null ? CACHE : left <= CACHE_ALERT_MIN ? ALERT : left <= CACHE_WARN_MIN ? WARN : CACHE
    const cacheText = e.props.isWorking ? '…' : left === null ? '—' : left === 0 ? '已过期' : `${left}分钟`

    // One line always: narrower bands drop the quota bars, then the total cost and the long labels;
    // whatever still does not fit is clipped rather than wrapped.
    const cols = e.props.bodyColumns
    const isFull = cols >= DESK_FULL_COLUMNS
    const isMid = cols >= DESK_MID_COLUMNS

    // auto-continue beside the quota: waiting for a reset, a set time, or just on; a click opens its controls.
    const wait = await read($, autoWait)
    const scheduled = await read($, autoScheduled)
    const isAutoOn = (await read($, autoOn)) === true
    const autoText = wait
      ? `⏳ ${clockTime(wait.wakeAt, at)}${isMid ? ' 自动续' : ''}`
      : scheduled
        ? `⏰ ${clockTime(scheduled.at, at)}${isMid ? ' 定时续' : ''}`
        : isAutoOn
          ? isMid ? '⟳ 自动续' : '⟳'
          : null
    const auto =
      autoText === null ? null : (
        <Button key="auto" plain onPress={() => openPane($, 'usage')}>
          <Text bold={!!(wait || scheduled)} dimColor={!wait && !scheduled} color={wait ? WARN : scheduled ? SPEED : undefined} size="footnote">
            {autoText}
          </Text>
        </Button>
      )

    const row = (
      <Box key="cockpit-row" flexDirection="row" columnGap={2} flexWrap="nowrap" paddingX={1} alignItems="center">
        <Box flexDirection="row" columnGap={isFull ? 3 : 2} flexWrap="nowrap" flexShrink={1} flexGrow={1} overflow="hidden">
          <Box flexDirection="row" columnGap={1} flexShrink={0}>
            <Text dimColor size="footnote">{isFull ? 'Turn' : '#'}</Text>
            <Text bold tabular size="footnote">{String(s.turn)}</Text>
          </Box>
          <Box flexDirection="row" columnGap={1} flexShrink={0}>
            <Text color={SPEED} size="footnote">⚡</Text>
            <Text bold tabular size="footnote">{s.speed === null ? '—' : isFull ? `${s.speed} tok/s` : `${s.speed}/s`}</Text>
          </Box>
          <Box flexDirection="row" columnGap={1} flexShrink={0}>
            <Text bold tabular color={MONEY} size="footnote">{s.turnCost === null ? '—' : usd(s.turnCost)}</Text>
            {isMid ? <Text dimColor size="footnote">/</Text> : null}
            {isMid ? <Text bold tabular size="footnote">{usd(s.total)}</Text> : null}
          </Box>
          <Box flexDirection="row" columnGap={1} flexShrink={0}>
            <Text color={cacheColor} size="footnote">{isMid ? '缓存' : '⧗'}</Text>
            <Text bold tabular color={cacheColor} size="footnote">{isMid ? cacheText : cacheText.replace('分钟', 'm')}</Text>
          </Box>
          {list.map(w => (
            <Box key={w.kind} flexDirection="row" columnGap={1} alignItems="center" flexShrink={0}>
              <Text dimColor size="footnote">{LABELS[w.kind] ?? w.kind}</Text>
              {isFull ? <Svg source={bar(w.percentUsed, level(w.percentUsed), 48)} alt={`${Math.round(w.percentUsed)}%`} width={48} height={6} /> : null}
              <Text bold tabular color={level(w.percentUsed)} size="footnote">{`${Math.round(w.percentUsed)}%`}</Text>
            </Box>
          ))}
          {auto}
          <Box flexDirection="row" columnGap={1} alignItems="center" flexShrink={0}>
            <Text dimColor size="footnote">{isMid ? '上下文' : 'ctx'}</Text>
            {isMid ? <Svg source={bar(s.context, level(s.context), 48)} alt={`${Math.round(s.context)}%`} width={48} height={6} /> : null}
            <Text bold tabular color={level(s.context)} size="footnote">{`${Math.round(s.context)}%`}</Text>
          </Box>
        </Box>
        <Box flexShrink={0}>
          <Button key="cockpit-open" plain onPress={() => openPane($)}>
            <Text color={ACCENT} size="footnote">驾驶舱 ›</Text>
          </Button>
        </Box>
      </Box>
    )

    const found = await read($, project)
    const welcome =
      (await read($, isWelcomeShown)) && found !== null ? (
        <Box
          key="cockpit-welcome"
          flexDirection="column"
          borderStyle="round"
          borderColor={`${ACCENT}66`}
          backgroundColor={`${ACCENT}0d`}
          paddingX="sm"
          paddingY="xs"
          marginBottom="sm"
        >
          <Box flexDirection="row" columnGap="sm" alignItems="center" flexWrap="wrap">
            <Text size="caption" dimColor>欢迎回来</Text>
            <Text bold mono color={ACCENT}>{await $.session.cwd()}</Text>
            {gitLine({ Box, Text }, found.git)}
            <Box flexGrow={1} />
            <Button key="welcome-close" label="×" plain role="dismiss" onPress={() => update($, isWelcomeShown, () => false)} />
          </Box>
          {projectBody($, { Box, Text, Button }, found, await read($, openDoc), 100, true, Markdown)}
        </Box>
      ) : null

    const below = await next(e)
    return (
      <Box flexDirection="column">
        {welcome}
        {row}
        {below}
      </Box>
    )
  })


  // ── the pane: usage, project and prompts, one tab each ──

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    isTinted = e.surface !== 'terminal'
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Svg = 'Svg' in ui ? ui.Svg : undefined
    const Input = 'Input' in ui ? ui.Input : undefined
    const current = await read($, tab)
    const width = Math.max(20, (e.props.bodyColumns || e.viewport?.columns || 80) - 14)

    const tabs = (
      <Box key="tabs" flexDirection="row" columnGap="xs" marginBottom="sm">
        {TABS.map(t => (
          <Button
            key={`tab-${t.id}`}
            label={t.label}
            variant={t.id === current ? 'primary' : 'secondary'}
            onPress={async () => {
              await update($, tab, () => t.id)
              if (t.id === 'project') await scan($)
              if (t.id === 'usage') await refresh($)
            }}
          />
        ))}
      </Box>
    )

    let body
    if (current === 'usage') {
      const s = await read($, stats)
      const list = await read($, windows)
      const at = await read($, now)
      const expiresAt = await read($, cacheExpiresAt)
      const left = expiresAt === null || at === 0 ? null : Math.max(0, Math.ceil((expiresAt - at) / 60000))
      const cacheColor = left === null ? CACHE : left <= CACHE_ALERT_MIN ? ALERT : left <= CACHE_WARN_MIN ? WARN : CACHE

      const gauge = (key: string, label: string, pct: number, note: string) => (
        <Box key={key} flexDirection="column" alignItems="center" rowGap="xs" minWidth={GAUGE_CELLS}>
          {Svg ? (
            <Svg source={ring(pct, level(pct))} alt={`${label} ${Math.round(pct)}%`} width={RING} height={RING} />
          ) : (
            <Text bold color={level(pct)}>{`${Math.round(pct)}%`}</Text>
          )}
          <Text weight="semibold" size="footnote">{label}</Text>
          <Text dimColor size="caption">{note || ' '}</Text>
        </Box>
      )

      body = (
        <Box flexDirection="column" rowGap="sm">
          <Box flexDirection="row" columnGap="sm" rowGap="sm" flexWrap="wrap">
            {stat({ Box, Text }, 'turn', '轮次', String(s.turn), '本会话的第几轮')}
            {stat({ Box, Text }, 'speed', '输出速度', s.speed === null ? '—' : `${s.speed}`, s.speed === null ? '还没测到' : 'tok/s', SPEED)}
            {stat({ Box, Text }, 'cost', '本轮花费', s.turnCost === null ? '—' : usd(s.turnCost), `本会话 ${usd(s.total)}`, MONEY)}
            {stat(
              { Box, Text },
              'cache',
              '提示缓存',
              left === null ? '—' : left === 0 ? '已过期' : `${left} 分钟`,
              left === null ? '回答后开始计时' : left === 0 ? '下一轮会重新写入' : '后过期',
              cacheColor,
              Svg && left !== null ? (
                <Svg source={bar((left / 60) * 100, cacheColor, 120, 4)} alt={`缓存剩 ${left} 分钟`} width={120} height={4} />
              ) : null,
            )}
          </Box>
          {card(
            { Box, Text },
            'quota',
            '额度',
            <Box flexDirection="row" columnGap="md" rowGap="sm" flexWrap="wrap" justifyContent="space-around">
              {list.map(w => gauge(w.kind, AUTO_LABELS[w.kind] ?? w.kind, w.percentUsed, resetIn(w.resetsAt, at)))}
              {gauge('context', '上下文', s.context, '当前对话占用')}
            </Box>,
          )}
          {await autoSection($, ui, at)}
        </Box>
      )
    } else if (current === 'project') {
      const found = await read($, project)
      const cwd = await $.session.cwd()
      body =
        found === null ? (
          <Text dimColor>正在读取项目状态…</Text>
        ) : (
          <Box flexDirection="column" rowGap="sm">
            {card(
              { Box, Text },
              'repo',
              '仓库',
              <Box flexDirection="column" rowGap="xs">
                <Text mono weight="semibold">{cwd}</Text>
                {gitLine({ Box, Text }, found.git)}
              </Box>,
              <Button key="rescan" plain label="刷新" onPress={() => scan($)} />,
            )}
            {projectBody($, { Box, Text, Button }, found, await read($, openDoc), width, false, 'Markdown' in ui ? ui.Markdown : undefined)}
          </Box>
        )
    } else {
      const rawQuery = await read($, filter)
      const query = rawQuery.toLowerCase()
      const messages = await $.session.messages()
      // The session's own prompts, matched in order to the transcript rows drawn so far.
      const pool = [...drawn]
      const all = messages
        .filter(m => m.role === 'user' && isOwnPrompt(m.text))
        .map((m, i) => {
          const at = pool.findIndex(d => d.text.trim() === m.text.trim())
          const requestId = at >= 0 ? pool.splice(at, 1)[0]?.requestId : undefined
          return { n: i + 1, text: m.text, requestId }
        })
      const prompts = all.filter(p => !query || p.text.toLowerCase().includes(query)).reverse()
      const jump = async (requestId: string | undefined) => {
        if (!requestId) {
          $.ui.toast('这条还没在对话区加载过：往上滚动经过它一次后就能跳了')
          return
        }
        await scrollTo($, requestId, 'start')
      }
      body = (
        <Box flexDirection="column" rowGap="sm">
          <Box flexDirection="row" columnGap="sm" alignItems="flex-end">
            {Input ? (
              <Box flexGrow={1}>
                <Input
                  key="prompt-filter"
                  label="过滤"
                  placeholder="输入关键词"
                  value={rawQuery}
                  onInput={value => update($, filter, () => value)}
                  onSubmit={value => update($, filter, () => value)}
                />
              </Box>
            ) : (
              <Box flexGrow={1} />
            )}
            <Button key="bottom" label="↓ 回到底部" onPress={() => scrollToBottom($)} />
          </Box>
          <Text dimColor size="footnote">
            {query ? `「${query}」匹配 ${prompts.length} / ${all.length} 条` : `${prompts.length} 条消息`} · 最新的在上 · 点一条跳过去
          </Text>
          {prompts.length === 0 ? <Text dimColor>{query ? '没有匹配的消息。' : '还没有消息。'}</Text> : null}
          <Box flexDirection="column">
            {prompts.map(p => (
              <Box
                key={`row-${p.n}`}
                flexDirection="row"
                paddingX="xs"
                paddingY="xs"
                borderStyle={isTinted ? "round" : undefined}
                borderColor={tint("#00000000")}
                hover={isTinted ? { backgroundColor: HOVER_BG, borderColor: CARD_BORDER } : undefined}
              >
                <Button key={`p${p.n}`} plain onPress={() => jump(p.requestId)}>
                  <Text mono dimColor size="footnote">{`#${String(p.n).padStart(2, '0')}  `}</Text>
                  {oneLine(p.text, width)}
                  {p.requestId ? '' : <Text dimColor size="caption">{'  未加载'}</Text>}
                </Button>
              </Box>
            ))}
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {tabs}
        {body}
      </Box>
    )
  })
}

// ── drawing pieces: cards, stats, gauges, pills ──

type Elements = Pick<ReturnType<EngineInterface['ui']['resolve']>, 'Box' | 'Text' | 'Button'>
type Markdown = Extract<ReturnType<EngineInterface['ui']['resolve']>, { Markdown: unknown }>['Markdown']

// Tints of grey that read on a light and a dark page alike.
const CARD_BG = '#8080800d'
const CARD_BORDER = '#80808033'
const HOVER_BG = '#8080801f'
// The terminal draws no translucent colour: set per draw, it leaves the tints out there.
let isTinted = true
const tint = (color: string) => (isTinted ? color : undefined)
const RING = 76
// Widths are in character cells on every surface, not pixels: a stat card takes about a quarter of a wide
// pane and half of a narrow one, a gauge fits its ring, a form field half a wide card.
const STAT_CELLS = 22
const GAUGE_CELLS = 12
const FIELD_CELLS = 26

const ring = (pct: number, color: string, size = RING) => {
  const stroke = 7
  const c = size / 2
  const r = (size - stroke) / 2
  const len = 2 * Math.PI * r
  const p = Math.max(0, Math.min(100, pct))
  const arc =
    p > 0
      ? `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" ` +
        `stroke-dasharray="${((len * p) / 100).toFixed(2)} ${len.toFixed(2)}" transform="rotate(-90 ${c} ${c})"/>`
      : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${TRACK}" stroke-width="${stroke}"/>${arc}` +
    `<text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" font-family="system-ui,-apple-system,'Segoe UI',sans-serif" ` +
    `font-size="${Math.round(size * 0.22)}" font-weight="600" fill="${color}">${Math.round(p)}%</text></svg>`
  )
}

// A titled card; `extra` sits at the right of its title.
function card({ Box, Text }: Pick<Elements, 'Box' | 'Text'>, key: string, title: string, children: unknown, extra?: unknown) {
  return (
    <Box key={key} flexDirection="column" rowGap="xs" borderStyle="round" borderColor={tint(CARD_BORDER)} backgroundColor={tint(CARD_BG)} paddingX="sm" paddingY="xs">
      <Box flexDirection="row" alignItems="center">
        <Text dimColor size="footnote" weight="semibold">{title}</Text>
        <Box flexGrow={1} />
        {extra ?? null}
      </Box>
      {children}
    </Box>
  )
}

// One figure in a small card: a caption, the value large, a line under it.
function stat({ Box, Text }: Pick<Elements, 'Box' | 'Text'>, key: string, label: string, value: string, sub: string, color?: string, extra?: unknown) {
  return (
    <Box key={key} flexDirection="column" rowGap="xs" flexGrow={1} minWidth={STAT_CELLS} borderStyle="round" borderColor={tint(CARD_BORDER)} backgroundColor={tint(CARD_BG)} paddingX="sm" paddingY="xs">
      <Text dimColor size="caption">{label}</Text>
      <Text bold tabular size="title" color={color}>{value}</Text>
      {extra ?? null}
      <Text dimColor size="caption">{sub}</Text>
    </Box>
  )
}

// A short tinted label.
function pill(Text: Elements['Text'], key: string, text: string, color: string, isMono = false) {
  return (
    <Text key={key} mono={isMono} size="footnote" weight="medium" color={color} backgroundColor={tint(`${color}22`)}>
      {` ${text} `}
    </Text>
  )
}

const HOUR_MS = 60 * 60 * 1000
// The longest waits the picker offers, as /auto-continue on takes them.
const WAITS: { value: string; label: string; ms: number }[] = [
  { value: '6h', label: '最多等 6 小时', ms: 6 * HOUR_MS },
  { value: '12h', label: '最多等 12 小时', ms: 12 * HOUR_MS },
  { value: '1d', label: '最多等 1 天', ms: 24 * HOUR_MS },
  { value: '2d', label: '最多等 2 天', ms: 48 * HOUR_MS },
  { value: '3d', label: '最多等 3 天', ms: 72 * HOUR_MS },
]
// The set times the picker offers: `in` a span, or `at` a clock time.
const WHENS: { value: string; label: string }[] = [
  { value: 'in 30m', label: '30 分钟后' },
  { value: 'in 1h', label: '1 小时后' },
  { value: 'in 2h', label: '2 小时后' },
  { value: 'in 5h', label: '5 小时后' },
  { value: 'at 09:00', label: '下一个 9:00' },
]
const isSpan = (text: string) => /^\d+(?:\.\d+)?\s*(?:d|h|m|天|小时|分钟|分)$/i.test(text.trim())

async function scheduleAuto($: EngineInterface, when: string) {
  const message = (await read($, autoMessage)).trim()
  await runAuto($, message ? `${when} ${message}` : when)
}

// The usage tab's auto-continue card: what it waits for, and fields that run its command. Absent when it is not installed.
async function autoSection($: EngineInterface, ui: ReturnType<EngineInterface['ui']['resolve']>, at: number) {
  const { Box, Text, Button } = ui
  const Input = 'Input' in ui ? ui.Input : undefined
  const Select = 'Select' in ui ? ui.Select : undefined
  const isOn = await read($, autoOn)
  if (isOn === null) return null
  const wait = await read($, autoWait)
  const scheduled = await read($, autoScheduled)
  const maxWait = await read($, autoMaxWait)
  const message = await read($, autoMessage)

  const badge = wait
    ? pill(Text, 'auto-badge', '等待额度刷新', WARN)
    : scheduled
      ? pill(Text, 'auto-badge', '已定时', SPEED)
      : isOn
        ? pill(Text, 'auto-badge', '已开启', MONEY)
        : pill(Text, 'auto-badge', '未开启', '#8a8a8a')

  const status =
    wait || scheduled ? (
      <Box key="auto-status" flexDirection="column" rowGap="xs" paddingX="sm" paddingY="xs" backgroundColor={tint(`${wait ? WARN : SPEED}14`)} borderStyle="round" borderColor={tint(`${wait ? WARN : SPEED}40`)}>
        {wait ? (
          <Text color={WARN}>
            <Text bold>{`⏳ ${wait.kind ? (AUTO_LABELS[wait.kind] ?? wait.kind) : '额度'}用完`}</Text>
            {`，${clockTime(wait.wakeAt, at)} 刷新后自动继续`}
          </Text>
        ) : null}
        {scheduled ? (
          <Box flexDirection="row" alignItems="center" columnGap="sm">
            <Text color={SPEED}>
              <Text bold>{`⏰ ${clockTime(scheduled.at, at)}`}</Text>
              {` 发送「${scheduled.text}」`}
            </Text>
            <Box flexGrow={1} />
            <Button key="auto-cancel" plain label="取消定时" onPress={() => runAuto($, 'cancel')} />
          </Box>
        ) : null}
      </Box>
    ) : null

  // A surface with no fields (the phone) keeps the two buttons.
  if (!Input || !Select) {
    return card(
      { Box, Text },
      'auto',
      '自动继续',
      <Box flexDirection="column" rowGap="xs">
        {status}
        <Box flexDirection="row" columnGap="xs" flexWrap="wrap">
          <Button key="auto-toggle" label={isOn ? '关闭额度自动继续' : '开启额度自动继续'} onPress={() => runAuto($, isOn ? 'off' : 'on')} />
          {scheduled ? null : <Button key="auto-in-1h" label="1 小时后继续" onPress={() => runAuto($, 'in 1h')} />}
        </Box>
      </Box>,
      badge,
    )
  }

  // The wait picker shows the session's wait; one the picker does not list is shown as its own row.
  const known = WAITS.find(w => w.ms === maxWait)
  const waitOptions = [
    { value: 'off', label: '关' },
    ...(isOn && maxWait !== null && !known ? [{ value: 'current', label: `最多等 ${Math.round((maxWait / HOUR_MS) * 10) / 10} 小时` }] : []),
    ...WAITS.map(w => ({ value: w.value, label: w.label })),
  ]
  const waitValue = !isOn ? 'off' : known ? known.value : maxWait !== null ? 'current' : '1d'

  const field = (key: string, title: string, hint: string, control: unknown) => (
    <Box key={key} flexDirection="column" rowGap="xs" flexGrow={1} minWidth={FIELD_CELLS}>
      <Text weight="semibold" size="footnote">{title}</Text>
      {control}
      <Text dimColor size="caption">{hint}</Text>
    </Box>
  )

  return card(
    { Box, Text },
    'auto',
    '自动继续',
    <Box flexDirection="column" rowGap="sm">
      {status}
      <Box flexDirection="row" columnGap="md" rowGap="sm" flexWrap="wrap">
        {field(
          'auto-wait-field',
          '额度用完后',
          '刷新时间在这个范围内，就自动发消息继续',
          <Select key="auto-wait" options={waitOptions} value={waitValue} onSelect={value => (value === 'current' ? undefined : runAuto($, value === 'off' ? 'off' : `on ${value}`))} />,
        )}
        {field(
          'auto-when-field',
          '定时继续',
          '到点发送下面的内容',
          <Select
            key="auto-when"
            options={[{ value: 'none', label: '选一个时间…' }, ...WHENS]}
            value="none"
            onSelect={value => (value === 'none' ? undefined : scheduleAuto($, value))}
          />,
        )}
      </Box>
      <Box flexDirection="row" columnGap="md" rowGap="sm" flexWrap="wrap">
        {field(
          'auto-at-field',
          '或指定时间',
          '14:30、10/22 09:00，或 2h、90m',
          <Input
            key="auto-at"
            placeholder="14:30"
            submitLabel="定时"
            onSubmit={value => {
              const when = value.trim()
              if (!when) return $.ui.toast('先填一个时间：14:30、10/22 09:00 或 2h')
              return scheduleAuto($, `${isSpan(when) ? 'in' : 'at'} ${when}`)
            }}
          />,
        )}
        {field(
          'auto-message-field',
          '定时发送的内容',
          '留空发送 continue',
          <Input
            key="auto-message"
            placeholder="continue"
            value={message}
            onInput={value => update($, autoMessage, () => value)}
            onSubmit={value => update($, autoMessage, () => value)}
          />,
        )}
      </Box>
    </Box>,
    badge,
  )
}

// The branch and its state, as pills.
function gitLine({ Box, Text }: Pick<Elements, 'Box' | 'Text'>, git: CockpitGit | null) {
  if (!git) return <Text dimColor>不是 git 仓库</Text>
  return (
    <Box flexDirection="row" columnGap="xs" flexWrap="wrap" alignItems="center">
      {pill(Text, 'branch', `⎇ ${git.branch}`, ACCENT, true)}
      {git.changes > 0 ? pill(Text, 'changes', `${git.changes} 个未提交改动`, WARN) : pill(Text, 'changes', '工作区干净', MONEY)}
      {git.ahead ? pill(Text, 'ahead', `↑${git.ahead} 未推送`, MONEY) : null}
      {git.behind ? pill(Text, 'behind', `↓${git.behind} 未拉取`, ALERT) : null}
    </Box>
  )
}

// Commits, docs, the last session and the recent ones: cards in the project tab, plain sections in the welcome card.
function projectBody(
  $: EngineInterface,
  { Box, Text, Button }: Elements,
  found: CockpitProject,
  shownDoc: string | null,
  width: number,
  isCompact = false,
  Markdown?: Markdown,
) {
  const at = found.scannedAt
  const git = found.git
  const latest = found.sessions[0]
  const section = (key: string, title: string, children: unknown) =>
    isCompact ? (
      <Box key={key} flexDirection="column" marginTop="sm" rowGap="xs">
        <Text dimColor size="footnote" weight="semibold">{title}</Text>
        {children}
      </Box>
    ) : (
      card({ Box, Text }, key, title, children)
    )

  return (
    <Box flexDirection="column" rowGap={isCompact ? 0 : 'sm'}>
      {git && git.commits.length > 0
        ? section(
            'commits',
            '最近提交',
            <Box flexDirection="column" rowGap="xs">
              {git.commits.map(c => (
                <Box key={c.hash} flexDirection="row" columnGap="sm" alignItems="center">
                  {pill(Text, `hash-${c.hash}`, c.hash, WARN, true)}
                  <Box flexGrow={1} flexShrink={1}>
                    <Text wrap="truncate-end">{cut(c.subject, width)}</Text>
                  </Box>
                  <Text dimColor size="caption">{ago(c.time, at)}</Text>
                </Box>
              ))}
            </Box>,
          )
        : null}
      {found.docs.length > 0
        ? section(
            'docs',
            '项目文档 · 点一下展开',
            <Box flexDirection="column">
              {found.docs.map(d => (
                <Box key={d.name} flexDirection="column">
                  <Box flexDirection="row" paddingX="xs" hover={isTinted ? { backgroundColor: HOVER_BG } : undefined}>
                    <Button key={`doc-${d.name}`} plain onPress={() => update($, openDoc, open => (open === d.name ? null : d.name))}>
                      <Text color={ACCENT} weight="semibold">{`${shownDoc === d.name ? '▾' : '▸'} ${d.name}`}</Text>
                      {'  '}
                      {cut([d.title, d.gist].filter(Boolean).join(' — '), width)}
                      <Text dimColor size="caption">{`  ${d.lines} 行`}</Text>
                    </Button>
                  </Box>
                  {shownDoc === d.name ? (
                    <Box flexDirection="column" marginLeft="sm" paddingX="sm" paddingY="xs" borderStyle="round" borderColor={tint(CARD_BORDER)}>
                      {Markdown ? (
                        <Markdown key={`md-${d.name}`} text={d.preview.join('\n')} />
                      ) : (
                        d.preview.map((line, i) => (
                          <Text key={`${d.name}-${i}`} dimColor wrap="truncate-end">{line}</Text>
                        ))
                      )}
                    </Box>
                  ) : null}
                </Box>
              ))}
            </Box>,
          )
        : null}
      {latest && (latest.recap || (latest.edited?.length ?? 0) > 0)
        ? section(
            'last',
            `上次会话做了什么 · ${ago(latest.time, at)}`,
            <Box flexDirection="column" rowGap="xs">
              {latest.recap ? <Text>{latest.recap}</Text> : null}
              {latest.edited && latest.edited.length > 0 ? (
                <Box flexDirection="row" columnGap="xs" rowGap="xs" flexWrap="wrap" alignItems="center">
                  <Text dimColor size="footnote">改动文件</Text>
                  {latest.edited.slice(0, EDITED_SHOWN).map(path => pill(Text, `edited-${path}`, path, '#8a8a8a', true))}
                  {latest.edited.length > EDITED_SHOWN ? <Text dimColor size="caption">{`等 ${latest.edited.length} 个`}</Text> : null}
                </Box>
              ) : null}
            </Box>,
          )
        : null}
      {section(
        'sessions',
        found.sessions.length > 0 ? '最近会话 · 在左侧会话列表里打开' : '最近会话',
        found.sessions.length > 0 ? (
          <Box flexDirection="column" rowGap="xs">
            {found.sessions.map(s => (
              <Box key={s.id} flexDirection="row" columnGap="sm" alignItems="center">
                <Box flexGrow={1} flexShrink={1}>
                  <Text wrap="truncate-end">{cut(s.prompt, width)}</Text>
                </Box>
                <Text dimColor size="caption">{`${s.prompts} 条 · ${ago(s.time, at)}`}</Text>
              </Box>
            ))}
          </Box>
        ) : (
          <Text dimColor>这个项目还没有别的会话</Text>
        ),
      )}
    </Box>
  )
}
