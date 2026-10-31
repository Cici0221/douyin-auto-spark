import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, test } from 'node:test'
import { chromium, type Browser, type Page } from 'playwright'
import { MessageSendError, sendMessageAndVerify } from './send-message'

let browser: Browser

before(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_TEST_BROWSER_PATH
      ? { executablePath: process.env.PLAYWRIGHT_TEST_BROWSER_PATH }
      : {}),
  })
})

after(async () => {
  await browser?.close()
})

type FixtureMode =
  | 'persist'
  | 'optimistic-only'
  | 'optimistic-cached'
  | 'noop'
  | 'delayed-history-noop'
  | 'empty-history'
  | 'failed'
  | 'pending'

interface Fixture {
  page: Page
  attempts: () => number
  reloads: () => number
  openFreshConversation: () => Promise<{ page: Page; close: () => Promise<void> }>
  close: () => Promise<void>
}

/** Local fake chat only. Nothing in these tests connects to Douyin or a real profile. */
async function createFixture(mode: FixtureMode, existing: string[] = []): Promise<Fixture> {
  const persistedMessages = [...existing]
  let sendAttempts = 0
  let historyLoads = 0
  const server = createServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/send') {
      let body = ''
      for await (const chunk of request) {
        body += String(chunk)
      }
      sendAttempts += 1
      const message = String(JSON.parse(body).message)
      if (mode === 'persist') {
        persistedMessages.push(message)
      }
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ mode }))
      return
    }
    historyLoads += 1
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(`<!doctype html><html><body>
      <div class="messageMessageListlist" style="min-height:30px"></div>
      <div class="messageEditorimChatEditorContainer">
        <div data-slate-editor="true" contenteditable="true" style="min-height:30px"></div>
        <svg class="messageMsgInputpublishBtn e2e-send-msg-btn" role="img" style="width:40px;height:40px;background:#ccc"><rect width="40" height="40" /></svg>
      </div>
      <script>
        const initialMessages = ${JSON.stringify(persistedMessages).replace(/</g, '\\u003c')};
        function appendMessage(text, state = 'settled') {
          const box = document.createElement('div');
          box.className = 'messageMessageBoxcontentBox messageMessageBoxisFromMe';
          box.dataset.fixtureState = state;
          const column = document.createElement('div');
          column.className = 'MessageBoxContentcolumnBox MessageBoxContentisFromMe';
          const row = document.createElement('div');
          row.className = 'MessageBoxContentrowBox';
          const content = document.createElement('div');
          content.dataset.e2e = 'msg-item-content';
          content.style.whiteSpace = 'pre-wrap';
          content.textContent = text;
          row.append(content);
          const side = document.createElement('div');
          side.className = 'MessageBoxContentSidewrapper';
          side.textContent = '状态区域不能进入正文匹配';
          row.append(side);
          column.append(row);
          const footer = document.createElement('div');
          footer.className = 'MessageBoxContentBottomwrapper MessageBoxContentBottomisFromMe';
          footer.textContent = '14:00 已读';
          column.append(footer);
          box.append(column);
          document.querySelector('.messageMessageListlist').append(box);
        }
        function loadHistory() {
          if (${JSON.stringify(mode)} !== 'empty-history') {
            const incoming = document.createElement('div');
            incoming.dataset.e2e = 'msg-item-content';
            incoming.textContent = '一条无关的历史来信';
            document.querySelector('.messageMessageListlist').append(incoming);
          }
          initialMessages.forEach(text => appendMessage(text));
          JSON.parse(localStorage.getItem('optimisticMessages') || '[]').forEach(text => appendMessage(text));
        }
        if (${JSON.stringify(mode)} === 'delayed-history-noop') setTimeout(loadHistory, 400);
        else loadHistory();
        document.querySelector('.e2e-send-msg-btn').addEventListener('click', async () => {
          const editor = document.querySelector('[contenteditable]');
          const text = editor.innerText;
          const reply = await fetch('/send', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({message:text})
          }).then(response => response.json());
          if (!reply.mode.endsWith('noop')) {
            appendMessage(text, reply.mode === 'failed' ? 'failed' : reply.mode === 'pending' ? 'pending' : 'settled');
          }
          if (reply.mode === 'optimistic-cached') {
            localStorage.setItem('optimisticMessages', JSON.stringify([text]));
          }
          editor.textContent = '';
        });
      </script></body></html>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  const context = await browser.newContext()
  const page = await context.newPage()
  const fixtureUrl = `http://127.0.0.1:${address.port}/`
  await page.goto(fixtureUrl)
  return {
    page,
    attempts: () => sendAttempts,
    reloads: () => historyLoads,
    openFreshConversation: async () => {
      const freshContext = await browser.newContext()
      const freshPage = await freshContext.newPage()
      await freshPage.goto(fixtureUrl)
      return { page: freshPage, close: () => freshContext.close() }
    },
    close: async () => {
      await context.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
}

function optionsFor(fixture: Fixture, message = '测试续火消息') {
  return {
    page: fixture.page,
    editorInput: fixture.page.locator('[data-slate-editor="true"][contenteditable="true"]'),
    message,
    reopenConversation: async () => {
      await fixture.page.locator('.messageMessageListlist').waitFor()
    },
    openFreshConversation: fixture.openFreshConversation,
    timeoutMs: 2000,
    pollIntervalMs: 40,
  }
}

test('a persisted multiline message succeeds only after a fresh history load', async () => {
  const fixture = await createFixture('persist')
  try {
    const result = await sendMessageAndVerify(optionsFor(fixture, '第一行\n第二行'))
    assert.equal(result.status, 'persisted')
    assert.equal(result.deliveryState, 'unknown')
    assert.equal(result.matchingMessagesBefore, 0)
    assert.equal(result.matchingMessagesAfter, 1)
    assert.equal(fixture.attempts(), 1)
    assert(fixture.reloads() >= 2)
  } finally {
    await fixture.close()
  }
})

test('an earlier identical message cannot make a no-op send look successful', async () => {
  const fixture = await createFixture('noop', ['测试续火消息'])
  try {
    await assert.rejects(sendMessageAndVerify(optionsFor(fixture)), (error: unknown) => {
      assert(error instanceof MessageSendError)
      assert.equal(error.outcome, 'unknown')
      assert.match(error.message, /未确认新增/)
      return true
    })
    assert.equal(fixture.attempts(), 1)
  } finally {
    await fixture.close()
  }
})

test('an optimistic bubble that disappears after reload is not a successful send', async () => {
  const fixture = await createFixture('optimistic-only')
  try {
    await assert.rejects(sendMessageAndVerify(optionsFor(fixture)), (error: unknown) => {
      assert(error instanceof MessageSendError)
      assert.equal(error.outcome, 'unknown')
      assert.match(error.message, /全新浏览器上下文/)
      return true
    })
    assert.equal(fixture.attempts(), 1)
    assert(fixture.reloads() >= 2)
  } finally {
    await fixture.close()
  }
})

test('delayed old history cannot turn a no-op send into success', async () => {
  const fixture = await createFixture('delayed-history-noop', ['测试续火消息'])
  try {
    await assert.rejects(sendMessageAndVerify(optionsFor(fixture)), /未确认新增/)
    assert.equal(fixture.attempts(), 1)
  } finally {
    await fixture.close()
  }
})

test('a locally cached optimistic message surviving reload still fails fresh-context verification', async () => {
  const fixture = await createFixture('optimistic-cached')
  try {
    await assert.rejects(sendMessageAndVerify(optionsFor(fixture)), /全新浏览器上下文/)
    assert.equal(fixture.attempts(), 1)
  } finally {
    await fixture.close()
  }
})

test('a fresh identical message must increase the count both before and after reload', async () => {
  const fixture = await createFixture('persist', ['测试续火消息'])
  try {
    const result = await sendMessageAndVerify(optionsFor(fixture))
    assert.equal(result.matchingMessagesBefore, 1)
    assert.equal(result.matchingMessagesAfter, 2)
    assert.equal(fixture.attempts(), 1)
  } finally {
    await fixture.close()
  }
})

test('a visible failed state rejects the send without trying a second click', async () => {
  const fixture = await createFixture('failed')
  try {
    await assert.rejects(
      sendMessageAndVerify({
        ...optionsFor(fixture),
        readDeliveryState: async (bubble) =>
          (await bubble.getAttribute('data-fixture-state')) === 'failed' ? 'failed' : 'unknown',
      }),
      /检测到消息发送失败状态/,
    )
    assert.equal(fixture.attempts(), 1)
  } finally {
    await fixture.close()
  }
})

test('a perpetually pending bubble times out without automatically resending', async () => {
  const fixture = await createFixture('pending')
  try {
    await assert.rejects(
      sendMessageAndVerify({
        ...optionsFor(fixture),
        readDeliveryState: async (bubble) =>
          (await bubble.getAttribute('data-fixture-state')) === 'pending' ? 'pending' : 'unknown',
      }),
      /未确认新增/,
    )
    assert.equal(fixture.attempts(), 1)
  } finally {
    await fixture.close()
  }
})

test('ambiguous visible send controls fail before any message is sent', async () => {
  const fixture = await createFixture('persist')
  try {
    await fixture.page.locator('.e2e-send-msg-btn').evaluate((node) => {
      node.after(node.cloneNode(true))
    })
    await assert.rejects(sendMessageAndVerify(optionsFor(fixture)), (error: unknown) => {
      assert(error instanceof MessageSendError)
      assert.equal(error.outcome, 'not-sent')
      assert.match(error.message, /唯一确定/)
      return true
    })
    assert.equal(fixture.attempts(), 0)
  } finally {
    await fixture.close()
  }
})

test('empty history is rejected before clicking send or assuming a zero baseline', async () => {
  const fixture = await createFixture('empty-history')
  try {
    await assert.rejects(sendMessageAndVerify(optionsFor(fixture)), (error: unknown) => {
      assert(error instanceof MessageSendError)
      assert.equal(error.outcome, 'not-sent')
      assert.match(error.message, /聊天历史尚未出现/)
      return true
    })
    assert.equal(fixture.attempts(), 0)
  } finally {
    await fixture.close()
  }
})
