import type { Locator, Page } from 'playwright'

// These selectors were inspected in the current Douyin chat DOM. The send control is an SVG.
export const SEND_MESSAGE_SELECTORS = {
  send: '.e2e-send-msg-btn',
  list: '.messageMessageListlist',
  outgoing: '.messageMessageListlist .messageMessageBoxcontentBox.messageMessageBoxisFromMe',
  body: '[data-e2e="msg-item-content"]',
} as const

export type DeliveryState = 'pending' | 'failed' | 'settled' | 'unknown'

export interface SendMessageOptions {
  page: Page
  editorInput: Locator
  message: string
  /** After this module reloads the page, reopen this same conversation and await its history. */
  reopenConversation: () => Promise<void>
  /** Open this conversation in a new cookie-only context with empty local storage and IndexedDB. */
  openFreshConversation: () => Promise<{ page: Page; close: () => Promise<void> }>
  /** Inspect only confirmed DOM state indicators; absence of a detector remains unknown. */
  readDeliveryState?: (messageBubble: Locator) => Promise<DeliveryState>
  timeoutMs?: number
  pollIntervalMs?: number
}

export interface PersistedMessageResult {
  status: 'persisted'
  deliveryState: 'settled' | 'unknown'
  matchingMessagesBefore: number
  matchingMessagesAfter: number
}

export class MessageSendError extends Error {
  readonly outcome: 'not-sent' | 'unknown'

  constructor(message: string, outcome: 'not-sent' | 'unknown', cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'MessageSendError'
    this.outcome = outcome
  }
}

/** Keep internal whitespace significant while normalizing browser line endings and Slate markers. */
export function normalizeMessageText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200b\ufeff]/g, '')
    .trim()
}

/**
 * Attempt exactly one send and confirm the message survives a fresh history load.
 * An optimistic bubble or a cleared editor alone never counts as success.
 * Any error after clicking is an unknown outcome and must not be blindly retried.
 */
export async function sendMessageAndVerify(
  options: SendMessageOptions,
): Promise<PersistedMessageResult> {
  const {
    page,
    editorInput,
    message,
    reopenConversation,
    openFreshConversation,
    readDeliveryState,
    timeoutMs = 15000,
    pollIntervalMs = 250,
  } = options
  let attemptedSend = false

  try {
    const expectedText = normalizeMessageText(message)
    if (!expectedText) {
      throw new Error('消息正文不能为空')
    }
    if (timeoutMs <= 0 || pollIntervalMs <= 0) {
      throw new Error('发送验证的超时和轮询间隔必须大于零')
    }

    const freshBefore = await openFreshConversation()
    let serverCountBefore: number
    try {
      await waitForStableHistory(freshBefore.page, timeoutMs, pollIntervalMs)
      serverCountBefore = (await findMatchingMessages(freshBefore.page, expectedText)).length
    } finally {
      await freshBefore.close()
    }
    await waitForStableHistory(page, timeoutMs, pollIntervalMs)
    const matchingBefore = await findMatchingMessages(page, expectedText)
    const countBefore = Math.max(serverCountBefore, matchingBefore.length)
    await editorInput.waitFor({ state: 'visible', timeout: timeoutMs })
    await editorInput.fill(message, { timeout: timeoutMs })
    await waitForEditorText(page, editorInput, expectedText, timeoutMs, pollIntervalMs)

    const sendControl = page.locator(`${SEND_MESSAGE_SELECTORS.send}:visible`)
    await sendControl.first().waitFor({ state: 'visible', timeout: timeoutMs })
    if ((await sendControl.count()) !== 1) {
      throw new Error('未能唯一确定当前会话的发送按钮，未尝试发送')
    }
    if ((await sendControl.getAttribute('aria-disabled')) === 'true') {
      throw new Error('发送按钮不可用，未尝试发送')
    }

    // A click can reach the server even if Playwright subsequently throws.
    attemptedSend = true
    await sendControl.click({ timeout: timeoutMs })
    await waitForNewMessage(
      page,
      expectedText,
      countBefore,
      readDeliveryState,
      timeoutMs,
      pollIntervalMs,
      '发送后未确认新增的本人消息，发送结果未知，请先核对聊天记录，勿直接重试',
    )

    // Force a full document reload ourselves; a callback that merely reopens a cached
    // panel must not accidentally validate the same optimistic in-memory bubble.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await reopenConversation()
    const freshAfter = await openFreshConversation()
    let persisted: { count: number; deliveryState: 'settled' | 'unknown' }
    try {
      await waitForStableHistory(freshAfter.page, timeoutMs, pollIntervalMs)
      persisted = await waitForNewMessage(
        freshAfter.page,
        expectedText,
        countBefore,
        readDeliveryState,
        timeoutMs,
        pollIntervalMs,
        '在全新浏览器上下文中未确认新消息已保存，发送结果未知，请先核对聊天记录，勿直接重试',
      )
    } finally {
      await freshAfter.close()
    }

    return {
      status: 'persisted',
      deliveryState: persisted.deliveryState,
      matchingMessagesBefore: countBefore,
      matchingMessagesAfter: persisted.count,
    }
  } catch (error) {
    if (error instanceof MessageSendError) {
      throw error
    }
    const detail = error instanceof Error ? error.message : String(error)
    throw new MessageSendError(detail, attemptedSend ? 'unknown' : 'not-sent', error)
  }
}

/** Wait for loaded history to settle before comparing message counts. */
async function waitForStableHistory(
  page: Page,
  timeoutMs: number,
  intervalMs: number,
): Promise<void> {
  const list = page.locator(SEND_MESSAGE_SELECTORS.list)
  await list.waitFor({ state: 'visible', timeout: timeoutMs })
  // These conversations have existing history. Without an inspected empty-state
  // indicator, an empty list is indistinguishable from history still loading.
  await list
    .locator('[data-e2e="msg-item-content"]')
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs })
    .catch(() => {
      throw new Error('聊天历史尚未出现，无法建立可靠的消息基线，未继续发送')
    })
  // Chat may keep a background request alive. Network quiet helps, while the
  // mandatory DOM stability check also covers delayed history rendering.
  await page
    .waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 10000) })
    .catch(() => {})
  const deadline = Date.now() + timeoutMs
  const stableForMs = Math.min(1000, timeoutMs / 2)
  let previousSignature: string | undefined
  let unchangedSince = Date.now()
  do {
    const signature = await list.innerText({ timeout: timeoutMs })
    if (signature !== previousSignature) {
      previousSignature = signature
      unchangedSince = Date.now()
    } else if (Date.now() - unchangedSince >= stableForMs) {
      return
    }
    await page.waitForTimeout(intervalMs)
  } while (Date.now() < deadline)
  throw new Error('聊天历史未稳定，无法可靠核对本次发送结果')
}

async function waitForEditorText(
  page: Page,
  editor: Locator,
  expectedText: string,
  timeoutMs: number,
  intervalMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let matchingReads = 0
  do {
    const actualText = normalizeMessageText(await editor.innerText({ timeout: timeoutMs }))
    matchingReads = actualText === expectedText ? matchingReads + 1 : 0
    if (matchingReads >= 2) {
      return
    }
    await page.waitForTimeout(intervalMs)
  } while (Date.now() < deadline)
  throw new Error('编辑器中的消息正文未稳定匹配，未尝试发送')
}

async function findMatchingMessages(page: Page, expectedText: string): Promise<Locator[]> {
  const outgoing = page.locator(SEND_MESSAGE_SELECTORS.outgoing)
  const indices = await outgoing.evaluateAll(
    (elements, { bodySelector, expected }) =>
      elements.flatMap((element, index) => {
        const body = element.querySelector<HTMLElement>(bodySelector)
        const text = (body?.innerText ?? '')
          .replace(/\r\n?/g, '\n')
          .replace(/[\u200b\ufeff]/g, '')
          .trim()
        return body && text === expected ? [index] : []
      }),
    { bodySelector: SEND_MESSAGE_SELECTORS.body, expected: expectedText },
  )
  return indices.map((index) => outgoing.nth(index))
}

async function waitForNewMessage(
  page: Page,
  expectedText: string,
  countBefore: number,
  readDeliveryState: SendMessageOptions['readDeliveryState'],
  timeoutMs: number,
  intervalMs: number,
  timeoutMessage: string,
): Promise<{ count: number; deliveryState: 'settled' | 'unknown' }> {
  const deadline = Date.now() + timeoutMs
  do {
    const matches = await findMatchingMessages(page, expectedText)
    if (matches.length > countBefore) {
      // Inspect every matching bubble: DOM order is not a reliable chronology in
      // the virtualized, column-reverse list. A failure must never be hidden by an
      // earlier matching message.
      const states = await Promise.all(
        matches.map((bubble) => readDeliveryState?.(bubble) ?? Promise.resolve('unknown' as const)),
      )
      if (states.includes('failed')) {
        throw new Error('检测到消息发送失败状态，请先核对聊天记录，勿直接重试')
      }
      if (!states.includes('pending')) {
        return {
          count: matches.length,
          deliveryState: states.every((state) => state === 'settled') ? 'settled' : 'unknown',
        }
      }
    }
    await page.waitForTimeout(intervalMs)
  } while (Date.now() < deadline)
  throw new Error(timeoutMessage)
}
