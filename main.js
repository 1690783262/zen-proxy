/**
 * 通用 AI API 中转网关（Deno Deploy · 精简版 v5）
 *
 * 只做一件事：把你的请求原样转发到注册过的供应商，途中剥离地理暴露头。
 * 不做协议转换、不存任何供应商 key。
 *
 * 用法（唯一的一种）：
 *   base_url = https://本域名/{access}/{供应商名}/v1
 *   api_key  = 该供应商自己的 key（Authorization 原样透传）
 *   {access}   = 环境变量 ACCESS_KEY（没配则用 PROXY_API_KEY）
 *   {供应商名} = 环境变量 PROVIDERS（JSON）里注册的名字，如
 *                {"amd":"https://developer.amd.com.cn/radeon/api/v1"}
 *
 * 端点：
 *   GET /stats   调用统计（公开，聚合数字）
 *   GET /ip      出网 IP 自检
 *   GET /        首页（说明 + 统计卡片）
 *   其余路径全部按中转处理
 *
 * 部署：GitHub 仓库根目录放 main.js + deno.json（{"unstable":["kv"]}）
 *       环境变量：PROXY_API_KEY（或 ACCESS_KEY）+ PROVIDERS，改完记得 Redeploy
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, api-key, x-api-key',
  'Access-Control-Max-Age': '86400',
}

// 身份暴露头：转发前剥离，防止泄露客户端真实地域（本网关存在的核心价值）
const STRIP_HEADERS = new Set([
  'cf-connecting-ip', 'cf-connecting-ipv6', 'cf-ipcountry', 'cf-ipcity',
  'cf-ipcontinent', 'cf-iplatitude', 'cf-iplongitude', 'cf-region',
  'cf-region-code', 'cf-postal-code', 'cf-metro-code', 'cf-timezone',
  'cf-visitor', 'cf-ray', 'cf-worker', 'cf-chl-out', 'cf-cache-status',
  'cf-apo-via', 'cf-edge-cache', 'cf-device-type', 'cf-request-id',
  'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host',
  'x-real-ip', 'true-client-ip', 'cdn-loop', 'fly-client-ip',
  'x-vercel-ip-country', 'x-vercel-forwarded-for', 'x-nf-client-connection-ip',
  'deno-deployment-id', 'x-deno-deployment-id', 'accept-encoding',
])

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  'content-length', 'host', 'expect',
])

// ============================================================================
// 调用统计（Deno KV 跨实例持久；KV 不可用时退化为单实例内存）
// ============================================================================
const STATS_MEM = {}
let kv = null
let kvErr = null
try { kv = await Deno.openKv() } catch (e) { kv = null; kvErr = String(e) }

/** "额度日"：跟随 Zen 免费额度规则，每天 UTC 0 点（北京时间早上 8 点）翻新 */
const bjDate = () => new Date().toISOString().slice(0, 10)

/**
 * 合并成一次原子提交并 await 完成。
 * ★ serverless 大坑：响应返回后实例会被冻结，没写完的异步操作直接丢弃，
 *   所以调用方必须在 return 响应之前 await 本函数。
 */
async function bumpAll(keys) {
  if (!kv) {
    for (const [k, n] of keys) STATS_MEM[k] = (STATS_MEM[k] || 0) + (n || 1)
    return
  }
  try {
    let atom = kv.atomic()
    for (const [k, n] of keys) atom = atom.sum(k.split('|'), BigInt(n || 1))
    await atom.commit()
    return
  } catch (e) {
    try { console.log('[gateway] stats-kv-fallback', keys.map((x) => x.join('=')).join(','), String(e)) } catch { }
  }
  for (const [k, n] of keys) STATS_MEM[k] = (STATS_MEM[k] || 0) + (n || 1)
}

/** 一次中转调用结束后的计数（仅聚合数字，不含对话内容） */
async function recordCall({ provider, model, status, usage }) {
  const kind = status === 200 ? 'ok' : (status === 429 ? '429' : 'err')
  const day = bjDate()
  const keys = [
    ['stat|calls', 1],
    [`stat|kind|${kind}`, 1],
    [`stat|day|${day}`, 1],
    // 模型维度按"额度日"记账：首页只展示本日调用过的模型，每天 8 点自动换新，
    // 避免标签列表随时间无限变长
    [`stat|dmodel|${day}|${provider}:${model || 'unknown'}`, 1],
  ]
  if (usage && (usage.input_tokens || usage.output_tokens)) {
    keys.push([`stat|tok_in|day|${day}`, usage.input_tokens || 0])
    keys.push([`stat|tok_out|day|${day}`, usage.output_tokens || 0])
  }
  await bumpAll(keys)
}

function safeJson(s) {
  if (!s) return null
  try { return JSON.parse(s) } catch { return null }
}

const HOME_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>API 中转网关</title>
<style>
body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
max-width:680px;margin:80px auto;padding:0 24px;color:#1f2328;line-height:1.7}
h1{font-size:22px;margin-bottom:8px}.ok{color:#1a7f37;font-weight:600}
code{background:#f0f2f4;padding:2px 6px;border-radius:4px;font-size:13px}
.box{background:#f6f8fa;border:1px solid #d8dee4;border-radius:8px;padding:16px 20px;margin:20px 0}
.stats{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0}
.stat{flex:1 1 120px;background:#fff;border:1px solid #d8dee4;border-radius:8px;padding:10px 14px;text-align:center}
.stat .num{font-size:24px;font-weight:700;color:#0969da}
.stat .lbl{font-size:12px;color:#57606a}
.pill{display:inline-block;padding:2px 10px;border-radius:99px;font-size:13px;margin:2px 4px;background:#eef1f4}
.muted{color:#8b949e;font-size:12px}
</style></head><body>
<h1>API 中转网关</h1>
<p class="ok">服务正常运行中。</p>
<div class="box">
<p style="margin-top:0"><b>调用统计</b> <span class="muted">（每天早 8 点"本日"翻新，总调用永不重置）</span></p>
<div class="stats">
<div class="stat"><div class="num" id="s-today">–</div><div class="lbl">本日调用</div></div>
<div class="stat"><div class="num" id="s-total">–</div><div class="lbl">总调用</div></div>
<div class="stat"><div class="num" id="s-ok">–</div><div class="lbl">成功</div></div>
<div class="stat"><div class="num" id="s-429">–</div><div class="lbl">限流 429</div></div>
</div>
<p id="s-extra" class="muted" style="margin-bottom:0">加载中…</p>
</div>
<div class="box">
<p style="margin-top:0"><b>零配置地址生成器</b> <span class="muted">（粘贴供应商地址，自动生成 base_url）</span></p>
<p>供应商 API 地址：<input id="g-upstream" type="text" placeholder="https://api.example.com/v1" style="width:100%;padding:6px 8px;margin:4px 0;border:1px solid #d8dee4;border-radius:6px;box-sizing:border-box;font-size:13px"></p>
<p>你的 access 钥匙：<input id="g-access" type="text" placeholder="sk-...（留空则用 {access} 占位）" style="width:100%;padding:6px 8px;margin:4px 0;border:1px solid #d8dee4;border-radius:6px;box-sizing:border-box;font-size:13px"></p>
<p><button onclick="genUrl()" style="padding:6px 18px;border:1px solid #0969da;background:#0969da;color:#fff;border-radius:6px;cursor:pointer">生成</button></p>
<p>生成的 base_url：</p>
<p><input id="g-result" type="text" readonly style="width:100%;padding:6px 8px;border:1px solid #d8dee4;border-radius:6px;box-sizing:border-box;font-size:13px;background:#fff"></p>
<p><button onclick="copyUrl()" id="g-copy" style="padding:6px 18px;border:1px solid #d8dee4;background:#f6f8fa;border-radius:6px;cursor:pointer">复制</button>
<span id="g-hint" class="muted"></span></p>
<p class="muted">api key 填该供应商自己的 key；http 上址会自动加 <code>http~</code> 前缀。</p>
</div>
<div class="box">
<p style="margin-top:0"><b>用法（两种写法，任选）</b></p>
<p><b>零配置</b>：base_url 填 <code>https://本域名/{access}/{供应商域名}/{路径...}</code></p>
<p>例：<code>https://本域名/sk-xxx/developer.amd.com.cn/radeon/api/v1</code>（域名段含点号即可，无需注册）</p>
<p><b>别名</b>：环境变量 PROVIDERS 注册 <code>{"amd":"https://developer.amd.com.cn/radeon/api"}</code>（地址<b>不含 /v1</b>），然后 base_url 填 <code>https://本域名/{access}/amd/v1</code></p>
<p>两种写法的 api key 都填<b>该供应商自己的 key</b>（网关原样透传，不存任何 key）。</p>
</div>
<p>其他端点：<code>GET /stats</code>（统计 JSON）、<code>GET /ip</code>（出网自检）</p>
<script>
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function genUrl(){
  const raw = document.getElementById('g-upstream').value.trim()
  const access = document.getElementById('g-access').value.trim() || '{access}'
  const hint = document.getElementById('g-hint')
  // 注意：本页由模板字符串生成，页面 JS 里不要用带反斜杠的正则（反斜杠会被转义吃掉），一律用字符串操作
  let scheme = 'https'
  let rest = raw
  if (rest.toLowerCase().indexOf('https://') === 0) { scheme = 'https'; rest = rest.slice(8) }
  else if (rest.toLowerCase().indexOf('http://') === 0) { scheme = 'http'; rest = rest.slice(7) }
  if (!rest) { hint.textContent = '请先填供应商地址'; return }
  const q = rest.indexOf('?')
  if (q >= 0) rest = rest.slice(0, q)
  while (rest.charAt(rest.length - 1) === '/') rest = rest.slice(0, -1)
  const first = rest.split('/')[0]
  if (first.indexOf('.') < 0 && first.indexOf(':') < 0) { hint.textContent = '地址第一段不像域名，请检查'; return }
  const hostPart = scheme === 'http' ? 'http~' + rest : rest
  document.getElementById('g-result').value = location.origin + '/' + access + '/' + hostPart
  hint.textContent = '生成成功，直接粘贴到客户端 base_url'
}
function copyUrl(){
  const el = document.getElementById('g-result')
  if (!el.value) return
  el.select()
  try { navigator.clipboard.writeText(el.value) } catch(e) { document.execCommand('copy') }
  document.getElementById('g-copy').textContent = '已复制 ✓'
  setTimeout(function(){ document.getElementById('g-copy').textContent = '复制' }, 1500)
}
async function loadStats(){
  try{
    const s = await (await fetch('/stats',{cache:'no-store'})).json()
    document.getElementById('s-today').textContent = s.本日.调用
    document.getElementById('s-total').textContent = s.总调用.次数
    document.getElementById('s-ok').textContent = s.总调用.成功
    document.getElementById('s-429').textContent = s.总调用['限流429']
    const models = (s.各模型||[]).map(m=>'<span class="pill">'+esc(m.model)+' × '+m.calls+'</span>').join('') || '<span class="muted">暂无记录</span>'
    document.getElementById('s-extra').innerHTML =
      '本日 tokens：输入 ' + s.本日.输入tokens + ' / 输出 ' + s.本日.输出tokens +
      ' · 其他错误 ' + s.总调用.其他错误 + ' · 鉴权失败 ' + s.总调用.鉴权失败 +
      '<br>' + models +
      '<br>KV：' + esc(s.KV状态) +
      '<br>数据截至 ' + esc(s.更新时间)
  }catch(e){ document.getElementById('s-extra').textContent = '统计暂不可用：' + e }
}
loadStats(); setInterval(loadStats, 30000)
</script>
</body></html>`

// ============================================================================

async function handle(request) {
  const url = new URL(request.url)

  const json = (obj, status = 200, extra = {}) =>
    new Response(JSON.stringify(obj, null, 2), {
      status,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...extra },
    })

  const env = (k) => Deno.env.get(k)
  const log = (obj) => { try { console.log('[gateway]', JSON.stringify(obj)) } catch { } }
  const rid = crypto.randomUUID().slice(0, 8)

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (url.pathname === '/') {
    return new Response(HOME_HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  }

  // ---- 出网 IP 自检 ----
  if (url.pathname === '/ip' || url.pathname === '/healthz') {
    let info = { ok: true, note: '网关在线' }
    if (url.pathname === '/ip') {
      try {
        const r = await (await fetch('https://ipapi.co/json/')).json()
        info = { 出网IP: r.ip, 出网国家: r.country_code, 出网城市: r.city }
      } catch (e) { info = { ok: false, error: String(e) } }
    }
    return json(info)
  }

  // ---- 统计（公开，仅聚合数字）----
  if (url.pathname === '/stats') {
    const out = {}
    if (kv) {
      try {
        for await (const e of kv.list({ prefix: ['stat'] })) {
          const v = e.value
          out[e.key.slice(1).join('|')] = typeof v === 'bigint' ? Number(v) : Number(v?.value ?? v) || 0
        }
      } catch (e) {
        try { console.log('[gateway] stats-list-error', String(e)) } catch { }
      }
    }
    for (const [k, v] of Object.entries(STATS_MEM)) out[k] = (out[k] || 0) + v
    const day = bjDate()
    const get = (k) => out[k] || 0
    return json({
      说明: '中转调用统计（仅聚合计数，不含对话内容）。"本日"=当前额度日，每天北京时间 8 点（UTC 0 点）翻新。',
      KV状态: kv ? '正常（跨实例持久）' : '不可用（退化为单实例内存，数字会不准）' + (kvErr ? '：' + kvErr : ''),
      更新时间: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
      本日: {
        日期: day,
        调用: get(`day|${day}`),
        输入tokens: get(`tok_in|day|${day}`),
        输出tokens: get(`tok_out|day|${day}`),
      },
      总调用: {
        次数: get('calls'),
        成功: get('kind|ok'),
        限流429: get('kind|429'),
        其他错误: get('kind|err'),
        鉴权失败: get('authfail'),
      },
      各模型: Object.entries(out)
        .filter(([k]) => k.startsWith(`dmodel|${day}|`))
        .map(([k, v]) => ({ model: k.slice(`dmodel|${day}|`.length), calls: v }))
        .sort((a, b) => b.calls - a.calls),
    })
  }

  // ---- 中转路由（两种写法，任选）----
  // 零配置：  /{access}/{域名}/{路径...}      域名段含点号即可，直接转发到 https://{域名}/{路径}
  //           例：/sk-xxx/developer.amd.com.cn/radeon/api/v1/chat/completions
  // 注册表：  /{access}/{供应商名}/v1/{rest}  供应商名不含点号，须在 PROVIDERS(JSON) 里注册
  const m = url.pathname.match(/^\/([^/]+)\/(.+)$/)
  if (!m) {
    return json({
      error: { message: '路径格式：/{access}/{供应商名}/v1/... 或 /{access}/{域名}/{路径...}' },
      文档: '打开首页查看用法',
    }, 404)
  }
  const [, access, tail] = m

  const ACCESS_KEY = env('ACCESS_KEY') || env('PROXY_API_KEY') || ''
  if (!ACCESS_KEY || access !== ACCESS_KEY) {
    log({ rid, path: url.pathname, authFail: true })
    await bumpAll([['stat|authfail', 1]])
    return json({ error: { message: 'Unauthorized: 网址里的 access 段不对' } }, 401)
  }

  // tail 的第一段：含点/冒号 = 域名（零配置模式）；否则 = PROVIDERS 里注册的供应商名
  // 域名段可用 "http~主机" / "https~主机" 指定协议（默认 https）
  const segs = tail.split('/')
  const first = segs[0]
  let base, provider, restPath
  if (first.includes('.') || first.includes(':')) {
    const scheme = first.startsWith('http~') ? 'http://' : first.startsWith('https~') ? 'https://' : 'https://'
    const host = first.replace(/^https?~/, '')
    base = scheme + host
    provider = host
    restPath = '/' + segs.slice(1).join('/')
  } else {
    const providers = safeJson(env('PROVIDERS'))
    if (!providers || typeof providers !== 'object' || !providers[first]) {
      return json({
        error: { message: `"${first}" 既不是域名也不是已注册的供应商名` },
        已注册: Object.keys(providers || {}),
        做法: '零配置直接写域名：/{access}/{域名}/{路径...}；或环境变量 PROVIDERS 注册名字后用 /{access}/{名字}/v1/...',
      }, 404)
    }
    base = String(providers[first]).replace(/\/+$/, '')
    provider = first
    restPath = '/' + segs.slice(1).join('/')
  }

  const incoming =
    request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim() ||
    request.headers.get('x-api-key') ||
    request.headers.get('api-key') ||
    ''
  if (!incoming) {
    log({ rid, provider: provider, authFail: true, missingUpstreamKey: true })
    await bumpAll([['stat|authfail', 1]])
    return json({ error: { message: '缺上游 API key：Authorization 头（Bearer）直接填该供应商的 key' } }, 401)
  }

  // ---- 转发头：剥离身份暴露头，Authorization 原样透传 ----
  const headers = new Headers()
  for (const [k, v] of request.headers) {
    const lk = k.toLowerCase()
    if (HOP_BY_HOP.has(lk) || STRIP_HEADERS.has(lk)) continue
    headers.set(k, v)
  }
  headers.set('Content-Type', 'application/json')
  headers.set('Accept', request.headers.get('Accept') || 'application/json')

  // ---- 请求体（解析出 model 供统计用）----
  let payload = null
  let rawBody = null
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    rawBody = await request.text()
    payload = safeJson(rawBody)
  }
  const model = payload?.model || 'unknown'

  const upstreamUrl = base + (restPath || '') + (url.search || '')
  log({ rid, provider: provider, model, path: restPath, phase: 'forward' })

  let upstream
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method, headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? rawBody : undefined,
      redirect: 'follow',
    })
  } catch (err) {
    await recordCall({ provider: provider, model, status: 0 })
    return json({ error: { message: '连不上上游: ' + String(err) } }, 502)
  }

  // ---- 非流式 JSON：读出来取 usage 记统计，再原样返回 ----
  const isStream = (upstream.headers.get('Content-Type') || '').includes('text/event-stream')
  if (!isStream) {
    const text = await upstream.text().catch(() => '')
    const j = safeJson(text)
    const usage = j && typeof j === 'object' ? j.usage : null
    await recordCall({ provider: provider, model, status: upstream.status, usage })
    if (!upstream.ok) {
      log({ rid, provider: provider, phase: 'upstream-error', status: upstream.status, body: text.slice(0, 120) })
    }
    return new Response(text || JSON.stringify({ error: { message: '上游返回 ' + upstream.status } }), {
      status: upstream.status,
      headers: { ...CORS_HEADERS, 'Content-Type': upstream.headers.get('Content-Type') || 'application/json' },
    })
  }

  // ---- 流式：直接透传，返回前记一次调用（不解析 usage）----
  await recordCall({ provider: provider, model, status: upstream.status })
  const outHeaders = new Headers({ ...CORS_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' })
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders })
}

// Deno Deploy 上端口由平台接管；本地测试用 PORT=8000 deno run --allow-net --allow-env --unstable-kv main.js
const port = Number(Deno.env.get('PORT') || 8000)
Deno.serve(handle, { port })
