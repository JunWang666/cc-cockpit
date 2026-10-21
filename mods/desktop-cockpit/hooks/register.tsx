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
    const { Box, Text, Button, Svg } = $.ui.resolve(e)
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
    const card =
      (await read($, isWelcomeShown)) && found !== null ? (
        <Box key="cockpit-welcome" flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} marginBottom={1}>
          <Box flexDirection="row" columnGap={2}>
            <Text bold color={ACCENT}>{await $.session.cwd()}</Text>
            {gitLine(Text, found.git)}
            <Box flexGrow={1} />
            <Button key="welcome-close" label="×" plain role="dismiss" onPress={() => update($, isWelcomeShown, () => false)} />
          </Box>
          {projectBody($, { Box, Text, Button }, found, await read($, openDoc), 100)}
        </Box>
      ) : null

    const below = await next(e)
    return (
      <Box flexDirection="column">
        {card}
        {row}
        {below}
      </Box>
    )
  })

  // ── the pane: usage, project and prompts, one tab each ──

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Svg = 'Svg' in ui ? ui.Svg : undefined
    const current = await read($, tab)
    const width = Math.max(20, (e.props.bodyColumns || e.viewport?.columns || 80) - 14)

    const tabs = (
      <Box key="tabs" flexDirection="row" columnGap={1} marginBottom={1}>
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
      const meter = (key: string, label: string, pct: number, note: string) => (
        <Box key={key} flexDirection="row" columnGap={2} alignItems="center">
          <Box width={6}><Text dimColor>{label}</Text></Box>
          {Svg ? <Svg source={bar(pct, level(pct), 160, 8)} alt={`${Math.round(pct)}%`} width={160} height={8} /> : null}
          <Text bold tabular color={level(pct)}>{`${Math.round(pct)}%`}</Text>
          <Text dimColor>{note}</Text>
        </Box>
      )
      body = (
        <Box flexDirection="column" rowGap={1}>
          <Box flexDirection="row" columnGap={4} flexWrap="wrap">
            <Box flexDirection="column">
              <Text dimColor size="footnote">轮次</Text>
              <Text bold tabular size="heading">{String(s.turn)}</Text>
            </Box>
            <Box flexDirection="column">
              <Text dimColor size="footnote">输出速度</Text>
              <Text bold tabular size="heading" color={SPEED}>{s.speed === null ? '—' : `${s.speed} tok/s`}</Text>
            </Box>
            <Box flexDirection="column">
              <Text dimColor size="footnote">本轮 / 本会话</Text>
              <Text bold tabular size="heading" color={MONEY}>
                {s.turnCost === null ? '—' : usd(s.turnCost)} <Text dimColor>/ {usd(s.total)}</Text>
              </Text>
            </Box>
            <Box flexDirection="column">
              <Text dimColor size="footnote">提示缓存</Text>
              <Text bold tabular size="heading" color={CACHE}>
                {left === null ? '—' : left === 0 ? '已过期' : `还剩 ${left} 分钟`}
              </Text>
            </Box>
          </Box>
          <Box flexDirection="column" rowGap={0}>
            {list.map(w => meter(w.kind, LABELS[w.kind] ?? w.kind, w.percentUsed, resetIn(w.resetsAt, at)))}
            {meter('context', '上下文', s.context, '')}
          </Box>
        </Box>
      )
    } else if (current === 'project') {
      const found = await read($, project)
      body =
        found === null ? (
          <Text dimColor>正在读取项目状态…</Text>
        ) : (
          <Box flexDirection="column">
            <Box flexDirection="row" columnGap={2}>
              <Text bold color={ACCENT}>{await $.session.cwd()}</Text>
              {gitLine(Text, found.git)}
            </Box>
            {projectBody($, { Box, Text, Button }, found, await read($, openDoc), width)}
          </Box>
        )
    } else {
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
      const jump = async (requestId: string | undefined) => {
        if (!requestId) {
          $.ui.toast('这条还没在对话区加载过：往上滚动经过它一次后就能跳了')
          return
        }
        await scrollTo($, requestId, 'start')
      }
      body = (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={2}>
            <Text dimColor>
              {query ? `过滤「${query}」· ` : ''}
              {prompts.length} 条消息，最新的在上 · 点一条跳过去
            </Text>
            <Box flexGrow={1} />
            {query ? <Button key="clear-filter" plain label="清除过滤" onPress={() => update($, filter, () => '')} /> : null}
            <Button key="bottom" plain onPress={() => scrollToBottom($)}>
              <Text color={ACCENT}>↓ 回到底部</Text>
            </Button>
          </Box>
          {prompts.length === 0 && <Text dimColor>还没有消息。</Text>}
          {prompts.map(p => (
            <Button key={`p${p.n}`} plain onPress={() => jump(p.requestId)}>
              <Text dimColor>#{p.n} </Text>
              {oneLine(p.text, width)}
              {p.requestId ? '' : <Text dimColor> ·未加载</Text>}
            </Button>
          ))}
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

// ── shared pieces of the welcome card and the project tab ──

type Elements = Pick<ReturnType<EngineInterface['ui']['resolve']>, 'Box' | 'Text' | 'Button'>

function gitLine(Text: Elements['Text'], git: CockpitGit | null) {
  if (!git) return <Text dimColor>不是 git 仓库</Text>
  return (
    <Text>
      ⎇ {git.branch}
      {git.changes > 0 ? <Text color={WARN}>{`  ${git.changes} 个未提交改动`}</Text> : <Text dimColor>  工作区干净</Text>}
      {git.ahead ? <Text color={MONEY}>{`  ↑${git.ahead}`}</Text> : null}
      {git.behind ? <Text color={ALERT}>{`  ↓${git.behind}`}</Text> : null}
    </Text>
  )
}

function projectBody($: EngineInterface, { Box, Text, Button }: Elements, found: CockpitProject, shownDoc: string | null, width: number) {
  const at = found.scannedAt
  const git = found.git
  const latest = found.sessions[0]
  return (
    <Box flexDirection="column">
      {git && git.commits.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>最近提交</Text>
          {git.commits.map(c => (
            <Text key={c.hash}>
              <Text mono color={WARN}>{c.hash}</Text> {cut(c.subject, width)} <Text dimColor>{ago(c.time, at)}</Text>
            </Text>
          ))}
        </Box>
      ) : null}
      {found.docs.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>项目文档 · 点一下展开</Text>
          {found.docs.map(d => (
            <Box key={d.name} flexDirection="column">
              <Button key={`doc-${d.name}`} plain onPress={() => update($, openDoc, open => (open === d.name ? null : d.name))}>
                <Text color={ACCENT}>{shownDoc === d.name ? '▾ ' : '▸ '}{d.name}</Text>{' '}
                {cut([d.title, d.gist].filter(Boolean).join(' — '), width)}
                <Text dimColor>{` · ${d.lines}行`}</Text>
              </Button>
              {shownDoc === d.name ? (
                <Box flexDirection="column" paddingLeft={2}>
                  {d.preview.map((line, i) => (
                    <Text key={`${d.name}-${i}`} dimColor wrap="truncate-end">{line}</Text>
                  ))}
                </Box>
              ) : null}
            </Box>
          ))}
        </Box>
      ) : null}
      {latest && (latest.recap || (latest.edited?.length ?? 0) > 0) ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{`上次会话做了什么 · ${ago(latest.time, at)}`}</Text>
          {latest.recap ? <Text>{latest.recap}</Text> : null}
          {latest.edited && latest.edited.length > 0 ? (
            <Text>
              <Text dimColor>改动文件 </Text>
              {latest.edited.slice(0, EDITED_SHOWN).join('、')}
              {latest.edited.length > EDITED_SHOWN ? <Text dimColor>{` 等${latest.edited.length}个`}</Text> : null}
            </Text>
          ) : null}
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>{found.sessions.length > 0 ? '最近会话 · 在左侧会话列表里打开' : '这个项目还没有别的会话'}</Text>
        {found.sessions.map(s => (
          <Text key={s.id}>
            {cut(s.prompt, width)} <Text dimColor>{`· ${s.prompts}条 · ${ago(s.time, at)}`}</Text>
          </Text>
        ))}
      </Box>
    </Box>
  )
}
