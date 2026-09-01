/**
 * OpenCode Zen -> OpenAI 兼容代理（Deno Deploy 版）
 *
 * 为什么从 Cloudflare Pages 换过来：Cloudflare 的出网请求被 Zen 判定为中国
 * （即使头已剥离、节点在 SEA），这是平台层行为，换 Deno Deploy（出网美国）解决。
 *
 * 部署：console.deno.com -> New App -> 连接 GitHub 仓库（网页上传文件即可）
 *       入口文件选本文件 main.js，无需构建命令。
 *
 * 环境变量（App 设置 -> Add/Edit environment variables，选 Secret + Production）：
 *   ZEN_API_KEY    = 你的 OpenCode Zen key
 *   PROXY_API_KEY  = 自己起一个，Hermes 里填它
 *
 * 端点：
 *   POST /v1/chat/completions   对话（支持流式）
 *   GET  /v1/models             模型列表
 *   GET  /zencheck              真实探活：直接问 Zen 一次（免鉴权，浏览器可开）
 *   GET  /ip                    节点位置自检（免鉴权）
 *   GET  /healthz               存活检查
 */

// ===== 默认值：一般不用改 =====
const ZEN_DEFAULT_BASE = 'https://opencode.ai/zen/v1'
const DEFAULT_MODEL = 'muse-spark-1.2-contributor-free'

// 模型短名 -> 真实 ID（Hermes 里填 "muse" 就行）
const DEFAULT_ALIASES = {
  'muse': 'muse-spark-1.2-contributor-free',
  'muse-1.2-free': 'muse-spark-1.2-contributor-free',
  'muse1.2free': 'muse-spark-1.2-contributor-free',
  'muse-free': 'muse-spark-1.2-contributor-free',
  'muse-spark-1.2-free': 'muse-spark-1.2-contributor-free',
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  'content-length', 'host', 'expect',
])

/**
 * 身份暴露头：转发前必须剥离。
 * Cloudflare/网关注入的 cf-ipcountry、x-forwarded-for 等会暴露用户真实地域，
 * 剥掉之后上游只能看到本函数出网 IP 的归属地（Deno Deploy 在美国）。
 */
const STRIP_HEADERS = new Set([
  'cf-connecting-ip', 'cf-connecting-ipv6', 'cf-ipcountry', 'cf-ipcity',
  'cf-ipcontinent', 'cf-iplatitude', 'cf-iplongitude', 'cf-region',
  'cf-region-code', 'cf-postal-code', 'cf-metro-code', 'cf-timezone',
  'cf-visitor', 'cf-ray', 'cf-worker', 'cf-chl-out', 'cf-cache-status',
  'cf-apo-via', 'cf-edge-cache', 'cf-device-type', 'cf-request-id',
  'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host',
  'x-real-ip', 'true-client-ip', 'cdn-loop', 'fly-client-ip',
  'x-vercel-ip-country', 'x-vercel-forwarded-for', 'x-nf-client-connection-ip',
  'deno-deployment-id', 'x-deno-deployment-id',
  'accept-encoding', // 避免上游压缩流二次解压问题
])

/** 中国大陆的 Cloudflare 节点代码（/ip 用，仅供参考） */
const CN_COLOS = new Set([
  'BJS', 'PEK', 'CAN', 'PVG', 'SHA', 'SZX', 'CGO', 'CKG', 'CTU', 'FOC',
  'HFE', 'HGH', 'INC', 'KHN', 'KMG', 'NKG', 'NGB', 'TAO', 'TSN', 'URC',
  'WUH', 'XIY', 'XMN', 'ZUH', 'SYX', 'KWL', 'DLC', 'SHE', 'HRB', 'LHW',
])

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, api-key, x-api-key',
  'Access-Control-Max-Age': '86400',
}

const HOME_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Zen 代理运行中（Deno Deploy）</title>
<style>
body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
max-width:640px;margin:80px auto;padding:0 24px;color:#1f2328;line-height:1.7}
h1{font-size:22px;margin-bottom:8px}.ok{color:#1a7f37;font-weight:600}
code{background:#f0f2f4;padding:2px 6px;border-radius:4px;font-size:13px}
.box{background:#f6f8fa;border:1px solid #d8dee4;border-radius:8px;padding:16px 20px;margin:20px 0}
a{color:#0969da}
</style></head><body>
<h1>Zen 代理已部署（Deno Deploy）</h1>
<p class="ok">服务正常运行中。</p>
<div class="box">
<p><code>POST /v1/chat/completions</code> — 对话（支持流式）</p>
<p><code>GET /v1/models</code> — 模型列表</p>
<p><code>GET /zencheck</code> — 真实探活，看 Zen 是否放行</p>
<p><code>GET /ip</code> — 出口节点位置</p>
</div>
<p>先打开 <a href="/zencheck">/zencheck</a> 验证。</p>
<p>Hermes 的 Base URL 填 <code>https://你的项目.deno.dev/v1</code>，
API Key 填你自己设的 <code>PROXY_API_KEY</code>。</p>
</body></html>`

function safeJson(s) {
  if (!s) return {}
  try { return JSON.parse(s) } catch { return {} }
}

async function handle(request) {
  const url = new URL(request.url)

  const json = (obj, status = 200, extra = {}) =>
    new Response(JSON.stringify(obj, null, 2), {
      status,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...extra },
    })

  const env = (k) => Deno.env.get(k)

  // 浏览器预检
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  // 根路径：状态提示页
  if (url.pathname === '/') {
    return new Response(HOME_HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  }

  // ---- 自检：出口节点位置（免鉴权）----
  if (url.pathname === '/ip' || url.pathname === '/healthz') {
    let info = { ok: true, note: '代理在线（Deno Deploy）' }
    if (url.pathname === '/ip') {
      try {
        // 用第三方服务看自己的出网 IP 归属，比 cdn-cgi/trace 准
        const r = await (await fetch('https://ipapi.co/json/')).json()
        info = {
          出网IP: r.ip,
          出网国家: r.country_code,
          出网城市: r.city,
          可用: r.country_code !== 'CN',
          说明: r.country_code === 'CN'
            ? '出网在中国大陆，Zen 会拒绝。'
            : '出网在境外（' + (r.country_name || r.country_code) + '），应可用。',
          下一步: '打开 /zencheck 做真实请求验证',
        }
      } catch (e) {
        info = { ok: false, error: String(e) }
      }
    }
    return json(info)
  }

  // ---- 真实探活：直接问 Zen（免鉴权）----
  if (url.pathname === '/zencheck') {
    const zenKey = env('ZEN_API_KEY')
    if (!zenKey) return json({ error: 'ZEN_API_KEY 没配' }, 500)
    const base = (env('ZEN_BASE_URL') || ZEN_DEFAULT_BASE).replace(/\/+$/, '')
    const probe = new Headers()
    probe.set('Authorization', `Bearer ${zenKey}`)
    probe.set('Content-Type', 'application/json')
    probe.set('User-Agent', env('FAKE_UA') || 'opencode')
    probe.set('x-opencode-client', env('OPENCODE_CLIENT') || 'tui')
    probe.set('x-opencode-project', env('OPENCODE_PROJECT') || 'hermes-zen-proxy')
    probe.set('x-opencode-session', crypto.randomUUID())
    probe.set('x-opencode-request', crypto.randomUUID())
    try {
      const r = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: probe,
        body: JSON.stringify({
          model: env('DEFAULT_MODEL') || DEFAULT_MODEL,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
        }),
      })
      const text = await r.text()
      const blocked = /RegionError|region|不可用/i.test(text)
      return json({
        Zen是否放行: r.ok && !blocked,
        上游HTTP状态: r.status,
        是否被地域拦截: blocked,
        上游返回: text.slice(0, 600),
        结论: r.ok && !blocked
          ? '通过！代理可用，去配 Hermes 吧。'
          : (blocked ? 'Zen 仍按地域拒绝。' : '请求失败，看上游返回内容排查。'),
      })
    } catch (e) {
      return json({ error: '探活请求失败: ' + String(e) }, 502)
    }
  }

  // ---- 配置检查 ----
  const PROXY_API_KEY = env('PROXY_API_KEY')
  const ZEN_API_KEY = env('ZEN_API_KEY')
  if (!PROXY_API_KEY || !ZEN_API_KEY) {
    return json({
      error: '环境变量没配好',
      缺少: [!PROXY_API_KEY && 'PROXY_API_KEY', !ZEN_API_KEY && 'ZEN_API_KEY'].filter(Boolean),
      做法: 'Deno Deploy 控制台 -> App -> Settings -> Environment Variables 添加后重新部署',
    }, 500)
  }

  // ---- 访问鉴权 ----
  const incoming =
    request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim() ||
    request.headers.get('x-api-key') ||
    request.headers.get('api-key') ||
    ''
  if (!incoming || incoming !== PROXY_API_KEY) {
    return json({ error: { message: 'Unauthorized: 代理钥匙不对或没带' } }, 401)
  }

  // ---- 组装上游地址 ----
  const base = (env('ZEN_BASE_URL') || ZEN_DEFAULT_BASE).replace(/\/+$/, '')
  const rest = url.pathname.startsWith('/v1/') ? url.pathname.slice(3) : url.pathname
  const upstreamUrl = base + rest + (url.search || '')

  // ---- 请求头：换 key、伪装 opencode、剥离身份头 ----
  const headers = new Headers()
  for (const [k, v] of request.headers) {
    const lk = k.toLowerCase()
    if (HOP_BY_HOP.has(lk) || STRIP_HEADERS.has(lk)) continue
    headers.set(k, v)
  }
  headers.set('Authorization', `Bearer ${ZEN_API_KEY}`)
  headers.set('Content-Type', 'application/json')
  headers.set('Accept', request.headers.get('Accept') || 'application/json')
  headers.set('User-Agent', env('FAKE_UA') || 'opencode')
  headers.set('x-opencode-client', env('OPENCODE_CLIENT') || 'tui')
  headers.set('x-opencode-project', env('OPENCODE_PROJECT') || 'hermes-zen-proxy')
  headers.set('x-opencode-session', crypto.randomUUID())
  headers.set('x-opencode-request', crypto.randomUUID())

  // ---- 请求体：模型别名重写 ----
  let body = null
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const raw = await request.text()
    if (raw) {
      try {
        const payload = JSON.parse(raw)
        const aliases = { ...DEFAULT_ALIASES, ...safeJson(env('MODEL_ALIASES')) }
        if (typeof payload.model === 'string' && aliases[payload.model]) {
          payload.model = aliases[payload.model]
        }
        if (!payload.model) payload.model = env('DEFAULT_MODEL') || DEFAULT_MODEL
        body = JSON.stringify(payload)
      } catch {
        body = raw
      }
    }
  }

  // ---- 转发 ----
  let upstream
  try {
    upstream = await fetch(upstreamUrl, { method: request.method, headers, body, redirect: 'follow' })
  } catch (err) {
    return json({ error: { message: '连不上上游: ' + String(err) } }, 502)
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '')
    return new Response(text || JSON.stringify({ error: { message: '上游返回 ' + upstream.status } }), {
      status: upstream.status,
      headers: { ...CORS_HEADERS, 'Content-Type': upstream.headers.get('Content-Type') || 'application/json' },
    })
  }

  // ---- 流式 / 非流式统一透传 ----
  const outHeaders = new Headers()
  for (const [k, v] of upstream.headers) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) outHeaders.set(k, v)
  }
  for (const [k, v] of Object.entries(CORS_HEADERS)) outHeaders.set(k, v)
  outHeaders.delete('content-encoding')
  outHeaders.set('Cache-Control', 'no-store')

  return new Response(upstream.body, { status: upstream.status, headers: outHeaders })
}

// 本地测试可用 PORT=8793 deno run main.js 指定端口；Deno Deploy 上端口由平台接管
const port = Number(Deno.env.get('PORT') || 8000)
Deno.serve(handle, { port })
