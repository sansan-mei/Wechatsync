/* Spike: offscreen iframe 写入站点首方缓存，不创建可见网站 tab。仅 fork 验证。 */
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

async function main() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE)
  const output = path.resolve('codefather-smoke-output')
  await fs.mkdir(output, { recursive: true })
  const fixture = path.join(process.env.RUNNER_TEMP || process.cwd(), 'codefather-offscreen-fixture')
  await fs.mkdir(fixture, { recursive: true })
  await fs.writeFile(path.join(fixture, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Codefather offscreen spike', version: '1.0',
    permissions: ['offscreen', 'tabs'], host_permissions: ['https://www.codefather.cn/*'],
    background: { service_worker: 'background.js' },
    content_scripts: [{ matches: ['https://www.codefather.cn/*'], js: ['content.js'], all_frames: true, run_at: 'document_start' }],
  }))
  await fs.writeFile(path.join(fixture, 'offscreen.html'), '<!doctype html><html><body><iframe src="https://www.codefather.cn/"></iframe></body></html>')
  await fs.writeFile(path.join(fixture, 'background.js'), `
let pending;
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.origin !== 'https://www.codefather.cn') return false;
  if (message.type === 'PROBE_GET') { reply(pending?.payload); return false; }
  if (message.type === 'PROBE_RESULT' && pending && message.id === pending.payload.id) {
    pending.resolve(message.result); return false;
  }
  return false;
});
globalThis.runHiddenDraft = async (payload) => {
  if (pending) throw new Error('probe already running');
  const before = (await chrome.tabs.query({})).map(tab => tab.id).sort();
  let timer;
  const completed = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('offscreen frame timeout')), 45000);
    pending = {payload: {...payload, id: crypto.randomUUID()}, resolve};
  });
  try {
    await chrome.offscreen.createDocument({url: 'offscreen.html', reasons: ['IFRAME_SCRIPTING', 'LOCAL_STORAGE'], justification: 'Verify hidden site-local draft storage without opening visible tabs'});
    const result = await completed;
    return {...result, before, after: (await chrome.tabs.query({})).map(tab => tab.id).sort()};
  } finally {
    clearTimeout(timer); pending = undefined;
    await chrome.offscreen.closeDocument();
  }
};
chrome.runtime.onInstalled.addListener(() => {});
`)
  await fs.writeFile(path.join(fixture, 'content.js'), `
if (window.top !== window) {
  chrome.runtime.sendMessage({type: 'PROBE_GET'}, (payload) => {
    if (!payload) return;
    let result;
    try {
      localStorage.setItem('add_post', payload.initial);
      const previous = localStorage.getItem('add_post');
      if (previous && JSON.parse(previous)?.value?.content?.trim()) {
        result = {success: false, error: '已有正文', raw: previous};
      } else {
        const raw = JSON.stringify({value: payload.value, expires: Date.now() + 86400000});
        localStorage.setItem('add_post', raw);
        result = {success: localStorage.getItem('add_post') === raw, raw: localStorage.getItem('add_post')};
      }
    } catch (error) { result = {success: false, error: String(error)}; }
    chrome.runtime.sendMessage({type: 'PROBE_RESULT', id: payload.id, result});
  });
}
`)
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true, serviceWorkers: 'block',
    args: [`--disable-extensions-except=${fixture}`, `--load-extension=${fixture}`],
  })
  let page
  try {
    await context.route('**/*', route => ['GET', 'HEAD'].includes(route.request().method()) ? route.continue() : route.abort())
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 })
    const value = { title: 'Wechatsync 无可见网页同步验证', content: '# 隐藏页面缓存验证\n\nwechatsync-offscreen-marker' }
    const initial = JSON.stringify({value: {title: '旧标题', content: ''}, expires: Date.now() + 86400000})
    const hidden = await worker.evaluate(payload => globalThis.runHiddenDraft(payload), {initial, value})
    await fs.writeFile(path.join(output, 'offscreen-write.json'), JSON.stringify(hidden, null, 2))
    assert.equal(hidden.success, true, hidden.error)
    assert.deepEqual(hidden.before, hidden.after, 'hidden sync must not create a visible tab')
    assert.equal(JSON.parse(hidden.raw).value.content, value.content)
    const offscreenAfter = await worker.evaluate(() => chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']}))
    assert.equal(offscreenAfter.length, 0, 'offscreen must be closed after write')

    // 写入完成后才模拟用户主动打开编辑器，不属于隐藏同步过程。
    page = await context.newPage()
    await page.goto('https://www.codefather.cn/add/passage', {waitUntil: 'domcontentloaded'})
    await page.waitForFunction(expected => document.querySelector('input.add-passage-title-input')?.value === expected, value.title, {timeout: 30000})
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('add_post')).value.content), value.content)
    await page.screenshot({path: path.join(output, 'editor.png'), fullPage: true})
    await page.close(); page = undefined

    const old = JSON.stringify({value: {title: '不能覆盖', content: '已有正文'}, expires: null})
    const blocked = await worker.evaluate(payload => globalThis.runHiddenDraft(payload), {initial: old, value})
    assert.equal(blocked.success, false)
    assert.equal(blocked.raw, old)
    assert.deepEqual(blocked.before, blocked.after)
    const finalContexts = await worker.evaluate(() => chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']}))
    assert.equal(finalContexts.length, 0)
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({
      offscreenWritePassed: true, noVisibleTabsCreatedDuringSync: true, firstPartyEditorRestored: true,
      oldContentPreserved: true, offscreenCleanedUp: true,
      realAccountAuthTested: false, serverWritesAllowed: false,
    }, null, 2))
    console.log('PASS: offscreen 隐藏 iframe 写入与网站首方缓存一致；同步过程未新增可见标签页；事后主动打开编辑器成功恢复内容；旧稿保护与清理通过。')
  } finally {
    if (page && !page.isClosed()) {
      await fs.writeFile(path.join(output, 'page.html'), await page.content()).catch(() => {})
      await page.screenshot({path: path.join(output, 'last-page.png')}).catch(() => {})
    }
    await context.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
