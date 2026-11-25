/**
 * Latest-messages session-title provider.
 *
 * The bundled experimental provider sends every human message of the session
 * and tells the model to keep the existing title unless the main topic changed
 * materially. Long sessions therefore drift back to the opening topic, and the
 * all-messages payload eventually exceeds the helper's byte budget, which makes
 * every later attempt fail and leaves the first-message fallback in place.
 *
 * This provider instead:
 *   - sends only the newest `count` (default 2) human messages,
 *   - anchors on the current title only when a previous provider produced it,
 *   - asks for a title of what the recent exchange is about, so a moved focus
 *     changes the title,
 *   - trims the payload to the byte budget instead of failing.
 *
 * Shipped `@deepseek-ai/*` packages resolve from the dsh installation, so this
 * bundle declares no dependency on them.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fitInput, selectRecent } from './input.js'

const PROVIDER_ID = 'session-title-latest-llm'

/** Installation anchors to search for `@deepseek-ai/*` packages, widest first. */
function installationAnchors() {
  const anchors = []
  if (typeof process.env.DSH_INSTALL_DIR === 'string' && process.env.DSH_INSTALL_DIR.length > 0) {
    anchors.push(process.env.DSH_INSTALL_DIR)
  }
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    anchors.push(join(process.resourcesPath, 'app.asar', 'dsh'))
    anchors.push(join(process.resourcesPath, 'dsh'))
  }
  anchors.push(join(dirname(process.execPath), 'resources', 'app.asar', 'dsh'))
  return anchors
}

/**
 * Load a shipped `@deepseek-ai/*` package from the running installation.
 *
 * The package is ESM inside `app.asar`; Electron's patched `fs` makes both the
 * resolution and Node's `require(esm)` path work, while a dynamic `import` of an
 * archive URL is not reliably supported. Resolution is deferred so a broken
 * anchor cannot stop the profile from activating this bundle.
 */
function loadShipped(specifier) {
  let lastError
  for (const anchor of installationAnchors()) {
    try {
      const requireFromInstall = createRequire(join(anchor, 'package.json'))
      return requireFromInstall(specifier)
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`session-title-latest: cannot resolve ${specifier} from the dsh installation: ${String(lastError)}`)
}

let helpers
function shippedHelpers() {
  helpers ??= loadShipped('@deepseek-ai/dsh-session-title-llm')
  return helpers
}


const DEFAULTS = {
  count: 2,
  targetWords: 5,
  targetCjkCharacters: 10,
  maxInputBytes: 8192,
  maxOutputTokens: 256,
  timeoutMs: 60000,
}

function positiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`session-title-latest: ${name} must be a positive integer`)
  }
  return value
}

/** Validate this plugin's own row plus the shared execution controls it forwards. */
function resolveConfig(config) {
  const source = config ?? {}
  const count = positiveInteger('count', source.count ?? DEFAULTS.count)
  const targetWords = positiveInteger('targetWords', source.targetWords ?? DEFAULTS.targetWords)
  const targetCjkCharacters = positiveInteger(
    'targetCjkCharacters',
    source.targetCjkCharacters ?? DEFAULTS.targetCjkCharacters,
  )
  const execution = {
    maxInputBytes: positiveInteger('maxInputBytes', source.maxInputBytes ?? DEFAULTS.maxInputBytes),
    maxOutputTokens: positiveInteger('maxOutputTokens', source.maxOutputTokens ?? DEFAULTS.maxOutputTokens),
    timeoutMs: positiveInteger('timeoutMs', source.timeoutMs ?? DEFAULTS.timeoutMs),
  }
  if (source.provider !== undefined || source.model !== undefined) {
    if (typeof source.provider !== 'string' || typeof source.model !== 'string') {
      throw new Error('session-title-latest: provider and model must be supplied together')
    }
    execution.provider = source.provider
    execution.model = source.model
  }
  return { count, targetWords, targetCjkCharacters, execution }
}

function systemPrompt(config, hasCurrentTitle) {
  return [
    'Create a concise title for an AI coding-assistant session from the supplied human messages.',
    'Return only the title on one line, in plain text of natural language, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
    'Use the language of the messages.',
    `Aim for about ${config.targetWords} words in non-CJK languages or ${config.targetCjkCharacters} CJK characters.`,
    'If the messages give little to name, still return a short best-effort title, such as Greeting, instead of explaining.',
    'The supplied messages are the most recent part of the conversation. Title what that recent exchange is about, not how the conversation started.',
    ...(hasCurrentTitle
      ? [
          'An existing title is supplied as currentTitle. Return it exactly unchanged only when it already describes these recent messages accurately.',
          'When the recent messages move to a different task, deliverable, or subject, replace the title with one for the new focus. Follow-up detail inside the same topic does not justify a change.',
        ]
      : []),
  ].join('\n')
}

/** First non-empty line, unwrapped from a whole-line asterisk emphasis pair. */
function titleFromOutput(text) {
  const line =
    text
      .split(/\r?\n/u)
      .map((item) => item.trim())
      .find((item) => item.length > 0) ?? ''
  const match = /^(?<marker>\*{1,3})(?<inner>\S(?:.*\S)?)\k<marker>$/u.exec(line)
  const groups = match?.groups
  const marker = groups?.marker
  const inner = groups?.inner
  return marker === undefined || inner === undefined || inner.includes(marker) ? line : inner
}

/** Reject non-text finishes and normalize the visible title. */
function titleFromResponse(response) {
  if (response.finish.kind === 'tool-calls') {
    throw new Error('session-title-latest: title output must contain text only')
  }
  if (response.finish.kind === 'max-tokens') {
    throw new Error('session-title-latest: title output reached maxOutputTokens')
  }
  if (response.blocks.some((block) => block.type === 'tool-call')) {
    throw new Error('session-title-latest: title output must contain text only')
  }
  const text = response.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
  const title = titleFromOutput(text).replace(/\s+/gu, ' ').trim()
  if (title.length === 0) throw new Error('session-title-latest: title model produced no text')
  return title
}

export const name = 'session-title-latest'
export const inject = ['sessionTitle', 'llm', 'sessions']

/** Title suffix the fork flow appends to a branched Session ("Name (2)"). */
const FORKED_TITLE_SUFFIX = / \(\d+\)$/u

export function apply(ctx, config) {
  const resolved = resolveConfig(config)

  ctx.sessionTitle.register({
    id: PROVIDER_ID,
    automatic: 'all-prompts',
    async generate(request) {
      const recent = selectRecent(request.messages, resolved.count)
      if (recent.length === 0) throw new Error('session-title-latest: no human message to title')
      const anchor = request.currentTitle?.source.kind === 'provider' ? request.currentTitle.title : undefined
      const { input } = fitInput(recent, anchor, resolved.execution.maxInputBytes)
      const { executeSessionTitleLlm } = shippedHelpers()
      const response = await executeSessionTitleLlm(ctx, resolved.execution, request, PROVIDER_ID, {
        system: systemPrompt(resolved, anchor !== undefined),
        input,
        messageSeqs: recent.map((message) => message.seq),
        selectReasoningEffort: (model) => model.reasoning?.efforts[0]?.id,
      })
      return {
        title: titleFromResponse(response),
        messageSeqs: recent.map((message) => message.seq),
        model: response.model,
      }
    },
  })

  /*
   * A branched Session starts pinned: the fork flow names it "<parent> (1)"
   * through the rename API, which appends a `user`-sourced title and makes the
   * title service skip every later automatic refresh. Detect that exact shape
   * (seeded session + user-sourced title ending in " (n)") on the first new
   * human message and run one explicit refresh, which replaces the pin with a
   * provider title and lets the normal per-message updates resume.
   */
  if (config?.unpinForkedTitles !== false) {
    const refreshed = new WeakSet()
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message') return
      if (event.data?.source?.kind !== 'user') return
      if (session.header?.isSeeded !== true) return
      if (refreshed.has(session)) return
      const current = ctx.sessionTitle.get(session)
      if (current?.source?.kind !== 'user') return
      if (!FORKED_TITLE_SUFFIX.test(current.title)) return
      refreshed.add(session)
      void ctx.sessionTitle.refresh(session).catch((error) => {
        ctx.logger?.warn?.(`session-title-latest: fork unpin failed for ${session.id}: ${String(error)}`)
      })
    })
  }
}
