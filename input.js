/**
 * Pure input shaping for the latest-messages title provider.
 *
 * No runtime imports: the host loads this module, and `node --test` can load it
 * from an ordinary Node process. The provider keeps only the newest human
 * messages (the task only needs the recent exchange), and it must never exceed
 * the LLM helper's byte budget, because that helper throws instead of trimming.
 */

/** Keep at most `count` trailing messages, preserving their order. */
export function selectRecent(messages, count) {
  const limit = Number.isInteger(count) && count > 0 ? count : 1
  return messages.slice(-limit)
}

/**
 * Frame the request as JSON so user text cannot forge structural delimiters.
 * @param {{ text: string }[]} messages newest-last window
 * @param {string | undefined} currentTitle provider-owned title to anchor on
 */
export function buildInput(messages, currentTitle) {
  const payload = messages.map((message) => ({ text: message.text }))
  if (currentTitle === undefined) {
    return `Create the session title from this JSON array of the most recent human messages:\n${JSON.stringify(payload)}`
  }
  return `Update the session title from this JSON object:\n${JSON.stringify({ currentTitle, messages: payload })}`
}

/** UTF-8 byte length of a string. */
export function byteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Keep the tail of `text` within `maxBytes` without splitting a code point.
 * The newest part of a message is usually the actual instruction.
 */
export function keepTail(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  let start = Math.max(0, buffer.length - maxBytes)
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1
  return buffer.subarray(start).toString('utf8')
}

/**
 * Build input no larger than `maxBytes`: drop the oldest messages first, then
 * trim the remaining text from the head.
 * @returns {{ input: string, messages: { text: string }[] }}
 */
export function fitInput(messages, currentTitle, maxBytes) {
  let window = messages.slice()
  let anchor = currentTitle
  for (;;) {
    const input = buildInput(window, anchor)
    if (byteLength(input) <= maxBytes) return { input, messages: window }
    if (window.length > 1) {
      window = window.slice(1)
      continue
    }
    const overhead = byteLength(buildInput([{ text: '' }], anchor))
    if (overhead >= maxBytes && anchor !== undefined) {
      // The anchored frame alone is too large; a fresh title is still better
      // than failing every refresh on a tiny budget.
      anchor = undefined
      continue
    }
    const room = Math.max(0, maxBytes - overhead)
    const trimmed = keepTail(window[0].text, room)
    const nextWindow = [{ text: trimmed }]
    return { input: buildInput(nextWindow, anchor), messages: nextWindow }
  }
}
