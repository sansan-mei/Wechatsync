/* 原生 Chrome 后台标签页回归：不新增权限，不上传、不发布。 */
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { CodefatherAdapter } = require('../packages/core/dist/index.js')

async function main() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE)
  const output = path.resolve('codefather-smoke-output')
  await fs.mkdir(output, { recursive: true })
  assert.equal(require('../packages/extension/dist/manifest.json').permissions.includes('offscreen'), false)
  const fixture = path.join(process.env.RUNNER_TEMP || process.cwd(), 'codefather-background-tab-fixture')
  await fs.mkdir(fixture, { recursive: true })
  await fs.writeFile(path.join(fixture, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Codefather background tab fixture', version: '1.0',
    permissions: ['scripting', 'tabs'], host_permissions: ['https://www.codefather.cn/*'],
    background: { service_worker: 'background.js' },
  }))
  await fs.writeFile(path.join(fixture, 'background.js'), 'chrome.runtime.onInstalled.addListener(() => {});')
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true, serviceWorkers: 'block',
    args: [`--disable-extensions-except=${fixture}`, `--load-extension=${fixture}`],
  })
  let page
  try {
    await context.route('**/*', route => ['GET', 'HEAD'].includes(route.request().method()) ? route.continue() : route.abort())
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 })
    const focusState = () => worker.evaluate(async () => ({
      activeTab: (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id,
      focusedWindow: (await chrome.windows.getLastFocused()).id,
    }))
    const before = await focusState()
    assert(before.activeTab, 'baseline must have an active tab')
    let initialCache = JSON.stringify({ value: { title: '旧标题', content: '' }, expires: Date.now() + 86400000 })
    const runtime = {
      type: 'extension',
      fetch: async url => {
        assert.equal(url, 'https://api.codefather.cn/api/user/get/login')
        return Response.json({ code: 0, data: { id: 'anonymous-cache-test-fixture' } })
      },
      tabs: {
        query: pattern => worker.evaluate(pattern => chrome.tabs.query({ url: pattern }), pattern),
        create: async (url, active) => {
          const pending = context.waitForEvent('page')
          const tab = await worker.evaluate(options => chrome.tabs.create(options), { url, active })
          page = await pending
          return { id: tab.id }
        },
        waitForLoad: async () => {
          await page.waitForLoadState('domcontentloaded')
          await page.evaluate(raw => localStorage.setItem('add_post', raw), initialCache)
        },
        executeScript: async (id, fn, args) => {
          const expression = `chrome.scripting.executeScript({target:{tabId:${JSON.stringify(id)}},world:'MAIN',func:(${fn.toString()}),args:${JSON.stringify(args)}})`
          const results = await worker.evaluate(expression)
          return results[0]?.result
        },
      },
    }
    const article = { title: 'Wechatsync 后台标签页验证', markdown: '# 后台写入缓存\n\nwechatsync-background-tab-marker' }
    const adapter = new CodefatherAdapter()
    await adapter.init(runtime)
    const result = await adapter.publish(article)
    await fs.writeFile(path.join(output, 'save-result.json'), JSON.stringify(result, null, 2))
    assert.equal(result.success, true, result.error)
    assert.equal(result.draftOnly, true)
    assert.equal(adapter.meta.name, '编程导航')
    await page.waitForURL('https://www.codefather.cn/add/passage', { timeout: 60000 })
    await page.waitForFunction(expected => document.querySelector('input.add-passage-title-input')?.value === expected, article.title, { timeout: 30000 })
    const after = await focusState()
    assert.deepEqual(after, before, 'background save and navigation must preserve active tab and window')
    const cache = await page.evaluate(() => JSON.parse(localStorage.getItem('add_post')))
    assert.equal(cache.value.content, article.markdown)
    await page.screenshot({ path: path.join(output, 'editor.png'), fullPage: true })
    await page.close(); page = undefined

    initialCache = JSON.stringify({ value: { title: '旧稿', content: '必须保留' }, expires: null })
    const protectedResult = await adapter.publish(article)
    assert.equal(protectedResult.success, false)
    assert(protectedResult.error.includes('已有本地草稿'), protectedResult.error)
    assert.equal(await page.evaluate(() => localStorage.getItem('add_post')), initialCache)
    assert.deepEqual(await focusState(), before)
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({
      nativeChromeInjection: true, backgroundTabOpened: true, activeTabUnchanged: true,
      focusedWindowUnchanged: true, before, after, noNewPermissions: true,
      emptyContentSyncPassed: true, existingDraftPreserved: true,
      titleRestored: true, cachedMarkdownVerified: true,
      realAccountAuthTested: false, serverWritesAllowed: false,
    }, null, 2))
    console.log('PASS: 后台新建和导航后，原活动标签及窗口ID均未改变；缓存恢复、旧稿保护通过；未新增 offscreen 权限。')
  } finally {
    if (page && !page.isClosed()) {
      await fs.writeFile(path.join(output, 'page.html'), await page.content()).catch(() => {})
      await page.screenshot({ path: path.join(output, 'last-page.png') }).catch(() => {})
    }
    await context.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
