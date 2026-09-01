/**
 * OpenCode Zen -> OpenAI Chat Completions 兼容代理（Deno Deploy 版 · 双协议 v3）
 *
 * 背景链路：
 *   1. muse-spark 系列被 Meta 地域政策限制 -> 需要境外出网代理
 *   2. Cloudflare 全平台出网被 Zen 判定为中国 -> 换 Deno Deploy（出网美国）
 *   3. Zen 的 muse 系列只支持 Responses API（/v1/responses），
 *      而 Hermes 只会说 Chat Completions -> 本代理做双向格式转换
 *
 * v3 修复：Hermes 报 "Model signaled a tool call but sent none"
 *   原因：muse 是推理模型，Responses 流里 function_call 可能"一次性完整到达"
 *   （只有 output_item.done 带完整 arguments，没有 added/arguments.delta 事件），
 *   旧版只处理增量事件 -> Hermes 收到 arguments 为空的 tool_calls -> 解析失败。
 *   v3 对 added / delta / done 三种事件都做兜底，保证最终一定送出完整参数。
 *
 * 部署：console.deno.com -> New App -> GitHub 仓库 -> Entrypoint 填 main.js
 * 环境变量：ZEN_API_KEY / PROXY_API_KEY（Secret + Production）
 *
 * 端点：
 *   POST /v1/chat/completions   对话（自动转换为 Responses API，支持流式+工具调用）
 *   GET  /v1/models             模型列表（透传）
 *   GET  /zencheck              真实探活（免鉴权，浏览器可开）
 *   GET  /ip                    出网 IP 自检（免鉴权）
 *   GET  /debug?key=PROXY_KEY   最近请求的诊断信息（排查工具调用问题用）
 */

// ===== 默认值：一般不用改 =====
const ZEN_DEFAULT_BASE = 'https://opencode.ai/zen/v1'
const DEFAULT_MODEL = 'muse-spark-1.2-contributor-free'

/** 这些模型前缀只支持 Responses API，走格式转换；其他模型原样透传 chat/completions */
const RESPONSES_MODELS = ['muse']

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

/** 身份暴露头：转发前剥离，防止泄露用户真实地域 */
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
  'accept-encoding',
])

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
<h1>Zen 代理已部署（Deno Deploy · Responses 转换 v3）</h1>
<p class="ok">服务正常运行中。</p>
<div class="box">
<p><code>POST /v1/chat/completions</code> — 对话（自动转 Responses API，支持流式+工具）</p>
<p><code>GET /v1/models</code> — 模型列表</p>
<p><code>GET /zencheck</code> — 真实探活</p>
<p><code>GET /debug?key=你的PROXY_KEY</code> — 最近请求诊断（排查工具调用问题）</p>
</div>
<p>Hermes 的 Base URL 填 <code>https://你的项目.deno.net/v1</code>。</p>
</body></html>`

// ===== 诊断环形缓冲：记录最近 8 次请求的关键信息（不含对话内容） =====
const DEBUG_LOG = []
function pushDbg(entry) {
  DEBUG_LOG.push(entry)
  if (DEBUG_LOG.length > 8) DEBUG_LOG.shift()
}

function safeJson(s) {
  if (!s) return {}
  try { return JSON.parse(s) } catch { return {} }
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter((c) => c && (c.type === 'text' || c.type === 'output_text'))
      .map((c) => c.text || '').join('')
  }
  return content == null ? '' : String(content)
}

/** arguments 字段规范化：上游可能给字符串 / 对象 / 空，统一成合法 JSON 字符串 */
function normalizeArgs(a) {
  if (a == null || a === '') return '{}'
  if (typeof a === 'string') {
    const t = a.trim()
    if (!t) return '{}'
    try { JSON.parse(t); return t } catch { return t } // 非法 JSON 原样给，让上层看到真实情况
  }
  return JSON.stringify(a)
}

// ============================================================================
// Chat Completions -> Responses 请求转换
// ============================================================================
function chatToResponsesRequest(chatBody) {
  const input = []
  for (const m of chatBody.messages || []) {
    if (!m) continue
    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id || '',
        output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      })
    } else if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      if (m.content) input.push({ role: 'assistant', content: textOf(m.content) })
      for (const tc of m.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: tc.id || '',
          name: tc.function?.name || '',
          arguments: normalizeArgs(tc.function?.arguments),
        })
      }
    } else {
      input.push({ role: m.role, content: textOf(m.content) })
    }
  }

  const out = { model: chatBody.model, input }
  if (Array.isArray(chatBody.tools) && chatBody.tools.length) {
    out.tools = chatBody.tools
      .filter((t) => t.type === 'function' && (t.function?.name || t.name))
      .map((t) => ({
        type: 'function',
        name: t.function?.name || t.name,
        description: t.function?.description || t.description || '',
        parameters: t.function?.parameters || t.parameters || { type: 'object', properties: {} },
      }))
  }
  if (chatBody.tool_choice !== undefined) {
    if (typeof chatBody.tool_choice === 'string') out.tool_choice = chatBody.tool_choice
    else if (chatBody.tool_choice?.function?.name) {
      out.tool_choice = { type: 'function', name: chatBody.tool_choice.function.name }
    }
  }
  const maxTok = chatBody.max_tokens ?? chatBody.max_completion_tokens
  if (maxTok) out.max_output_tokens = Math.max(maxTok, 512) // 推理模型给太小会 500
  if (chatBody.temperature !== undefined) out.temperature = chatBody.temperature
  if (chatBody.top_p !== undefined) out.top_p = chatBody.top_p
  if (chatBody.stop) out.stop = chatBody.stop
  out.stream = !!chatBody.stream
  return out
}

// ============================================================================
// Responses -> Chat Completions 响应转换（非流式）
// ============================================================================
function responsesToChatResponse(respJson, model) {
  let content = null
  const toolCalls = []
  const dbgCalls = []
  for (const item of respJson.output || []) {
    if (!item) continue
    if (item.type === 'message') {
      const t = textOf(item.content)
      if (t) content = (content || '') + t
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const args = normalizeArgs(item.arguments ?? item.input)
      toolCalls.push({
        id: item.call_id || item.id || 'call_' + crypto.randomUUID().slice(0, 8),
        type: 'function',
        function: { name: item.name || '', arguments: args },
      })
      dbgCalls.push({ name: item.name || '', call_id: item.call_id || item.id, argsLen: args.length })
    }
  }
  if (dbgCalls.length) {
    pushDbg({
      time: new Date().toISOString(), mode: 'non-stream', model,
      outputTypes: (respJson.output || []).map((o) => o?.type),
      functionCalls: dbgCalls, status: respJson.status,
    })
  }
  const message = { role: 'assistant', content }
  if (toolCalls.length) {
    message.tool_calls = toolCalls
    if (content == null) message.content = null
  }
  const u = respJson.usage || {}
  return {
    id: 'chatcmpl-' + String(respJson.id || crypto.randomUUID()).slice(0, 29),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
    }],
    usage: {
      prompt_tokens: u.input_tokens || 0,
      completion_tokens: u.output_tokens || 0,
      total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0),
    },
  }
}

// ============================================================================
// Responses SSE -> Chat Completions SSE 流式转换（v3：added/delta/done 全兜底）
// ============================================================================
function transformResponsesStreamToChat(upstreamBody, model, respId, dbg) {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  let started = false
  let sentText = false
  let toolCount = 0
  let emittedToolChunks = 0
  const events = {}
  // item_id -> { index, args, gotArgs, hasId }
  const items = new Map()
  let finishReason = null
  let usage = null

  const chunk = (delta, extra = {}) => ({
    id: 'chatcmpl-' + String(respId).slice(0, 29),
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: null, ...extra }],
  })

  const reader = upstreamBody.getReader()

  return new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))

      const ensureRole = () => {
        if (!started) { started = true; send(chunk({ role: 'assistant', content: '' })) }
      }

      const sendTool = (tc) => {
        ensureRole()
        emittedToolChunks++
        send(chunk({ delta: { tool_calls: [tc] } }))
      }

      /** 在 done 时兜底送出完整 arguments（上游"一次性给全"的场景） */
      const flushDoneCall = (item) => {
        const full = normalizeArgs(item.arguments ?? item.input)
        let it = items.get(item.id)
        if (!it) {
          // 上游从未发过 added 事件：整个调用在 done 才出现，现场补齐
          const i = toolCount++
          it = { index: i, args: '', gotArgs: false, hasId: false }
          items.set(item.id, it)
          sendTool({
            index: i, id: item.call_id || item.id, type: 'function',
            function: { name: item.name || '', arguments: '' },
          })
          it.hasId = !!(item.call_id || item.id)
        }
        // 参数从未流过 or 流的是空的 -> 一次性补全
        if (full !== '{}' && (!it.gotArgs || it.args.trim() === '' || it.args === '{}')) {
          it.args = full
          it.gotArgs = true
          sendTool({ index: it.index, function: { arguments: full } })
        }
        // added 时没有 id、done 才有 -> 补发 id
        if (!it.hasId && (item.call_id || item.id)) {
          it.hasId = true
          sendTool({ index: it.index, id: item.call_id || item.id, type: 'function', function: { name: item.name || '', arguments: '' } })
        }
        return { name: item.name || '', call_id: item.call_id || item.id, argsLen: full.length }
      }

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let idx
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const rawEvent = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)
            for (const line of rawEvent.split('\n')) {
              if (!line.startsWith('data:')) continue
              const dataStr = line.slice(5).trim()
              if (!dataStr || dataStr === '[DONE]') continue
              let ev
              try { ev = JSON.parse(dataStr) } catch { continue }
              if (dbg && ev.type) events[ev.type] = (events[ev.type] || 0) + 1
              switch (ev.type) {
                case 'response.output_text.delta':
                  if (ev.delta) {
                    ensureRole()
                    sentText = true
                    send(chunk({ content: ev.delta }))
                  }
                  break
                case 'response.output_item.added':
                  if (ev.item?.type === 'function_call' || ev.item?.type === 'custom_tool_call') {
                    const i = toolCount++
                    const initial = normalizeArgs(ev.item.arguments ?? ev.item.input)
                    const hasInitial = initial !== '{}'
                    items.set(ev.item.id, { index: i, args: hasInitial ? initial : '', gotArgs: hasInitial, hasId: !!(ev.item.call_id || ev.item.id) })
                    sendTool({
                      index: i, id: ev.item.call_id || ev.item.id, type: 'function',
                      function: { name: ev.item.name || '', arguments: hasInitial ? initial : '' },
                    })
                    if (dbg) dbg.toolCalls.push({ name: ev.item.name || '', call_id: ev.item.call_id || ev.item.id, via: 'added', initialArgsLen: initial.length })
                  }
                  break
                case 'response.function_call_arguments.delta':
                case 'response.custom_tool_call_input.delta': {
                  let it = items.get(ev.item_id)
                  if (!it) {
                    // 没见过 added：现场注册一个
                    const i = toolCount++
                    it = { index: i, args: '', gotArgs: false, hasId: false }
                    items.set(ev.item_id, it)
                    sendTool({ index: i, id: ev.item_id, type: 'function', function: { name: '', arguments: '' } })
                  }
                  it.args += ev.delta || ''
                  it.gotArgs = true
                  sendTool({ index: it.index, function: { arguments: ev.delta || '' } })
                  break
                }
                case 'response.output_item.done':
                  if (ev.item?.type === 'function_call' || ev.item?.type === 'custom_tool_call') {
                    const info = flushDoneCall(ev.item)
                    if (dbg && info) dbg.toolCalls.push({ ...info, via: 'done' })
                  }
                  break
                case 'response.completed':
                case 'response.incomplete': {
                  usage = ev.response?.usage || null
                  const out = ev.response?.output || []
                  // 兜底 1：没流过任何文本，但最终输出里有 message -> 一次性补发
                  if (!sentText) {
                    const t = out.filter((o) => o?.type === 'message').map((o) => textOf(o.content)).join('')
                    if (t) { ensureRole(); sentText = true; send(chunk({ content: t })) }
                  }
                  // 兜底 2：完整 output 里还有从未露面的 function_call -> 补发
                  for (const o of out) {
                    if ((o?.type === 'function_call' || o?.type === 'custom_tool_call') && !items.has(o.id)) {
                      const info = flushDoneCall(o)
                      if (dbg) dbg.toolCalls.push({ ...info, via: 'completed-scan' })
                    }
                  }
                  finishReason = toolCount ? 'tool_calls' : 'stop'
                  break
                }
                case 'response.failed':
                case 'error': {
                  const msg = ev.response?.error?.message || ev.error?.message || 'upstream stream error'
                  send(chunk({ content: `\n[upstream error: ${msg}]` }))
                  finishReason = finishReason || 'stop'
                  break
                }
                default:
                  break // reasoning 等 delta 直接丢弃
              }
            }
          }
        }
      } catch { /* 上游中断，按已收内容收尾 */ }
      send(chunk({}, { finish_reason: finishReason || (toolCount ? 'tool_calls' : 'stop') }))
      if (usage) {
        send({
          id: 'chatcmpl-' + String(respId).slice(0, 29),
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: {}, finish_reason: null }],
          usage: {
            prompt_tokens: usage.input_tokens || 0,
            completion_tokens: usage.output_tokens || 0,
            total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
          },
        })
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
      if (dbg) {
        dbg.events = events
        dbg.emittedToolChunks = emittedToolChunks
        dbg.finishReason = finishReason
        pushDbg(dbg)
      }
    },
  })
}

// ============================================================================

async function handle(request) {
  const url = new URL(request.url)

  const json = (obj, status = 200, extra = {}) =>
    new Response(JSON.stringify(obj, null, 2), {
      status,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...extra },
    })

  const env = (k) => Deno.env.get(k)

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (url.pathname === '/') {
    return new Response(HOME_HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  }

  // ---- 自检：出网 IP（免鉴权）----
  if (url.pathname === '/ip' || url.pathname === '/healthz') {
    let info = { ok: true, note: '代理在线（Deno Deploy · Responses 转换 v3）' }
    if (url.pathname === '/ip') {
      try {
        const r = await (await fetch('https://ipapi.co/json/')).json()
        info = {
          出网IP: r.ip, 出网国家: r.country_code, 出网城市: r.city,
          可用: r.country_code !== 'CN',
          说明: r.country_code === 'CN' ? '出网在中国大陆，Zen 会拒绝。' : '出网在境外，应可用。',
          下一步: '打开 /zencheck 做真实请求验证',
        }
      } catch (e) { info = { ok: false, error: String(e) } }
    }
    return json(info)
  }

  // ---- 真实探活（免鉴权）----
  if (url.pathname === '/zencheck') {
    const zenKey = env('ZEN_API_KEY')
    if (!zenKey) return json({ error: 'ZEN_API_KEY 没配' }, 500)
    const base = (env('ZEN_BASE_URL') || ZEN_DEFAULT_BASE).replace(/\/+$/, '')
    const mkHeaders = () => {
      const probe = new Headers()
      probe.set('Authorization', `Bearer ${zenKey}`)
      probe.set('Content-Type', 'application/json')
      probe.set('User-Agent', env('FAKE_UA') || 'opencode')
      probe.set('x-opencode-client', env('OPENCODE_CLIENT') || 'tui')
      probe.set('x-opencode-project', env('OPENCODE_PROJECT') || 'hermes-zen-proxy')
      probe.set('x-opencode-session', crypto.randomUUID())
      probe.set('x-opencode-request', crypto.randomUUID())
      return probe
    }
    const model = env('DEFAULT_MODEL') || DEFAULT_MODEL
    let resp
    try {
      const r = await fetch(base + '/responses', {
        method: 'POST', headers: mkHeaders(),
        body: JSON.stringify({ model, input: 'hi', max_output_tokens: 512 }),
      })
      const text = await r.text()
      resp = { 状态: r.status, 是否地域拦截: /RegionError|region|不可用/i.test(text), 返回: text.slice(0, 300) }
    } catch (e) { resp = { 错误: String(e) } }
    return json({
      Zen是否放行: resp.状态 === 200,
      responses_api探测: resp,
      结论: resp.状态 === 200
        ? '通过！代理可用（muse 系列走 Responses API，代理已自动转换），去配 Hermes 吧。'
        : 'Zen 探活失败，把本页内容发我。',
    })
  }

  // ---- 环境变量检查（后续所有路径都需要） ----
  const PROXY_API_KEY = env('PROXY_API_KEY')
  const ZEN_API_KEY = env('ZEN_API_KEY')
  if (!PROXY_API_KEY || !ZEN_API_KEY) {
    return json({
      error: '环境变量没配好',
      缺少: [!PROXY_API_KEY && 'PROXY_API_KEY', !ZEN_API_KEY && 'ZEN_API_KEY'].filter(Boolean),
      做法: 'Deno Deploy 控制台 -> Settings -> Environment Variables 添加后重新部署',
    }, 500)
  }

  // ---- 诊断端点（浏览器可开，用 query key 鉴权；不记录对话内容）----
  if (url.pathname === '/debug') {
    if ((url.searchParams.get('key') || '') !== PROXY_API_KEY) {
      return json({ error: '在网址后面加 ?key=你的PROXY_API_KEY' }, 401)
    }
    return json({
      说明: '最近 8 次经过转换层的请求诊断（不含对话内容）。在 Hermes 触发一次工具调用后再刷新本页。',
      最近请求: DEBUG_LOG,
    })
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

  // ---- 解析请求体 ----
  let payload = null
  let rawBody = null
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    rawBody = await request.text()
    if (rawBody) {
      try { payload = JSON.parse(rawBody) } catch { payload = null }
    }
  }

  // 模型别名重写
  if (payload && typeof payload.model === 'string') {
    const aliases = { ...DEFAULT_ALIASES, ...safeJson(env('MODEL_ALIASES')) }
    if (aliases[payload.model]) payload.model = aliases[payload.model]
  }
  const model = payload?.model || env('DEFAULT_MODEL') || DEFAULT_MODEL
  if (payload && !payload.model) payload.model = model

  // ---- 判断是否需要 Responses 转换 ----
  const prefixes = safeJson(env('RESPONSES_MODELS')).length
    ? safeJson(env('RESPONSES_MODELS'))
    : RESPONSES_MODELS
  const needConversion = url.pathname.endsWith('/chat/completions')
    && Array.isArray(prefixes)
    && prefixes.some((p) => typeof p === 'string' && model.startsWith(p))

  if (needConversion && payload) {
    // ============ Responses 转换路径 ============
    const responsesBody = chatToResponsesRequest(payload)
    const dbg = {
      time: new Date().toISOString(), model,
      stream: !!responsesBody.stream,
      toolCount: (responsesBody.tools || []).length,
      inputItems: (responsesBody.input || []).map((i) => i.type || i.role),
      upstreamStatus: null, events: {}, toolCalls: [], emittedToolChunks: 0, finishReason: null,
    }
    let upstream
    try {
      upstream = await fetch(base + '/responses', {
        method: 'POST', headers, body: JSON.stringify(responsesBody), redirect: 'follow',
      })
    } catch (err) {
      dbg.upstreamStatus = 'fetch-error'; dbg.error = String(err); pushDbg(dbg)
      return json({ error: { message: '连不上上游: ' + String(err) } }, 502)
    }
    dbg.upstreamStatus = upstream.status

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '')
      dbg.upstreamError = text.slice(0, 300); pushDbg(dbg)
      return new Response(text || JSON.stringify({ error: { message: '上游返回 ' + upstream.status } }), {
        status: upstream.status,
        headers: { ...CORS_HEADERS, 'Content-Type': upstream.headers.get('Content-Type') || 'application/json' },
      })
    }

    if (responsesBody.stream) {
      const outHeaders = new Headers({ ...CORS_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' })
      return new Response(transformResponsesStreamToChat(upstream.body, model, upstream.headers.get('x-request-id') || crypto.randomUUID(), dbg), { status: 200, headers: outHeaders })
    }
    const respJson = await upstream.json().catch(() => null)
    if (!respJson) { dbg.upstreamError = '非 JSON'; pushDbg(dbg); return json({ error: { message: '上游返回非 JSON' } }, 502) }
    const outHeaders = new Headers({ ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return new Response(JSON.stringify(responsesToChatResponse(respJson, model)), { status: 200, headers: outHeaders })
  }

  // ============ 普通透传路径（models、其他模型等） ============
  let body = rawBody
  if (payload && request.method !== 'GET' && request.method !== 'HEAD') {
    body = JSON.stringify(payload)
  }

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

  const outHeaders = new Headers()
  for (const [k, v] of upstream.headers) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) outHeaders.set(k, v)
  }
  for (const [k, v] of Object.entries(CORS_HEADERS)) outHeaders.set(k, v)
  outHeaders.delete('content-encoding')
  outHeaders.set('Cache-Control', 'no-store')

  return new Response(upstream.body, { status: upstream.status, headers: outHeaders })
}

// 本地测试可用 PORT=8000 deno run --allow-net --allow-env main.js；Deno Deploy 上端口由平台接管
const port = Number(Deno.env.get('PORT') || 8000)
Deno.serve(handle, { port })
