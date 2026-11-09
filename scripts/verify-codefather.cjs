/* 原生 Chrome 扩展注入回归：匿名上下文，不调用上传或发文接口。 */
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { CodefatherAdapter } = require('../packages/core/dist/index.js')

async function main() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE)
  const output = path.resolve('codefather-smoke-output')
  await fs.mkdir(output, { recursive: true })
  const fixture = path.join(process.env.RUNNER_TEMP || process.cwd(), 'codefather-injection-extension')
  await fs.mkdir(fixture, { recursive: true })
  await fs.writeFile(path.join(fixture, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Codefather injection fixture', version: '1.0',
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
    assert(worker.url().startsWith('chrome-extension://'))
    let initialCache = JSON.stringify({ value: { title: '旧标题', content: '', extra: '保留的站点字段' }, expires: Date.now() + 86400000 })
    const runtime = {
      type: 'extension',
      // 仅认证使用夹具；缓存写入、异常返回、tab 查询/创建均使用原生 Chrome API。
      fetch: async url => {
        assert.equal(url, 'https://api.codefather.cn/api/user/get/login')
        return Response.json({ code: 0, data: { id: 'anonymous-cache-test-fixture' } })
      },
      tabs: {
        query: pattern => worker.evaluate(pattern => chrome.tabs.query({ url: pattern }), pattern),
        create: async url => {
          const pending = context.waitForEvent('page')
          const tab = await worker.evaluate(url => chrome.tabs.create({ url, active: true }), url)
          page = await pending
          return { id: tab.id }
        },
        waitForLoad: async () => {
          await page.waitForLoadState('domcontentloaded')
          await page.evaluate(raw => localStorage.setItem('add_post', raw), initialCache)
          assert.equal(await page.evaluate(() => localStorage.getItem('add_post')), initialCache)
        },
        executeScript: async (id, fn, args) => {
          // fn 来自实际适配器的自包含函数；参数统一 JSON 序列化，不拼接用户代码。
          const expression = `chrome.scripting.executeScript({target:{tabId:${JSON.stringify(id)}},world:'MAIN',func:(${fn.toString()}),args:${JSON.stringify(args)}})`
          const results = await worker.evaluate(expression)
          return results[0]?.result
        },
      },
    }
    const article = { title: 'Wechatsync 空字符串草稿回归', markdown: '# 原生扩展注入验证\n\nwechatsync-cache-smoke-marker' }
    const adapter = new CodefatherAdapter()
    await adapter.init(runtime)
    const result = await adapter.publish(article)
    await fs.writeFile(path.join(output, 'empty-cache-result.json'), JSON.stringify(result, null, 2))
    assert.equal(result.success, true, result.error)
    assert.equal(result.draftOnly, true)
    assert.equal(adapter.meta.name, '编程导航')
    await page.waitForURL('https://www.codefather.cn/add/passage', { timeout: 60000 })
    await page.waitForFunction(expected => document.querySelector('input.add-passage-title-input')?.value === expected, article.title, { timeout: 30000 })
    const cache = await page.evaluate(() => JSON.parse(localStorage.getItem('add_post')))
    assert.equal(cache.value.content, article.markdown)
    await page.screenshot({ path: path.join(output, 'editor.png'), fullPage: true })
    await page.close()
    page = undefined

    initialCache = JSON.stringify({ value: { title: '不能覆盖的旧稿', content: '必须保留' }, expires: null })
    const protectedResult = await adapter.publish(article)
    assert.equal(protectedResult.success, false)
    assert(protectedResult.error.includes('已有本地草稿'), protectedResult.error)
    assert.equal(await page.evaluate(() => localStorage.getItem('add_post')), initialCache)
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({
      nativeChromeInjection: true, emptyContentSyncPassed: true, existingDraftPreserved: true,
      specificErrorReturned: protectedResult.error, titleRestored: true, cachedMarkdownVerified: true,
      realAccountAuthTested: false, serverWritesAllowed: false,
    }, null, 2))
    console.log('PASS: 原生 chrome.scripting 注入；正文为空可同步且不受 expires 影响，真实编辑器恢复内容，已有正文不覆盖。未验证真实登录，禁止网络写入。')
  } finally {
    if (page && !page.isClosed()) {
      await fs.writeFile(path.join(output, 'page.html'), await page.content()).catch(() => {})
      await page.screenshot({ path: path.join(output, 'last-page.png') }).catch(() => {})
    }
    await context.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
