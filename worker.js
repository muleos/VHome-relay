/**
 * VHome 云端中转 —— 「App 被清理后」把消息转成 MeoW 推送的那台服务器。
 *
 * 为什么必须有它：MeoW（api.chuckfang.com）是「收到 HTTP 就把内容弹成系统通知」的
 * 接口，触发它的那次 HTTP 必须由**活着的进程**发出。VHome 被系统清理 / 手机重启后，
 * 本机没有任何代码在跑 → 只能由云端代发。本 Worker 就是那台云端。
 *
 * 触发源（两条任选其一或都用，互为备份）：
 *  ① 腾讯云 IM 回调（推荐，服务端事件）：IM 控制台开启「发单聊消息之后回调」/
 *     「群组消息之后回调」，URL 填 https://<你的域名>/<TOKEN>/hook。
 *     好处：连别人用其它客户端（安卓端）发给你的消息也能覆盖。
 *  ② 客户端上报：发送方 App 发完消息 POST /<TOKEN>/relay。
 *     好处：不用动腾讯云 IM 控制台，装 VHome 的用户之间互发就能覆盖。
 *
 * 「接收方现在还在不在线」由 VHome 的心跳决定（POST /<TOKEN>/beat，默认 15s 一次）：
 *  · 心跳新鲜 ⇒ 对方的 App 进程活着 ⇒ 他自己会弹本机系统通知 ⇒ 这里**不推**（防重复）；
 *  · 心跳断了（被清理 / 重启手机）⇒ 这里代发 MeoW。
 *
 * 依赖：Workers KV（绑定名 VHOME_KV）；环境变量 TOKEN（口令，写在 URL 路径里）。
 * 华为 Push（P394）：环境变量 HMS_CLIENT_ID（默认 6917616847342319725）+
 * HMS_CLIENT_SECRET（AGC 项目设置 → 常规 → 应用；不配则 HMS 通道禁用、退回 MeoW）。
 * 互动消息代查（官方消息/评论/赞/@我的）需在 wrangler.toml 配 cron 触发：
 *   [triggers] crons = ["* * * * *"]
 * 部署见同目录 README.md。
 */

const MEOW_HOST = 'https://api.chuckfang.com';
/** P398：传送鸽通知接口（libv.cc）—— 云端唯一推送通道 */
const PIGEON_URL = 'https://libv.cc/pg/bot/notify/notify.php';
/** P400：通道开关 —— MeoW 与华为 HMS 推送按需求隐藏（实现保留，不启用） */
const ENABLE_MEOW = false;
const ENABLE_HMS = false;
/** AGC 应用 client_id（与 App 的 module.json5 metadata client_id 必须同值） */
const HMS_CLIENT_ID = '6917616847342319725';
const HMS_OAUTH_URL = 'https://oauth-login.cloud.huawei.com/oauth2/v3/token';
const HMS_PUSH_URL = `https://push-api.cloud.huawei.com/v1/${HMS_CLIENT_ID}/messages:send`;
/** starfans 服务端（与 App 的 ApiClient.BASE_URL 同源）+ 签名盐（ApiClient.SIGN_SALT） */
const STARFANS_BASE = 'https://api1.starfans.com';
const SIGN_SALT = '#xusong#';
/** 心跳超过这个时长就算离线（默认 45s = 3 个心跳周期） */
const OFFLINE_MS = 45000;
/** 同一接收者两条推送的最小间隔（MeoW 免费额度：3 秒 1 条，这里留余量） */
const COOLDOWN_MS = 5000;
/** 同一「发送者→接收者」在这个窗口内的重复事件（回调 + 客户端上报）只推一次 */
const DEDUP_MS = 12000;
/** 默认通知图标（发送者既没有头像、绑定里也查不到时用；换成你自己的图标 URL 即可） */
const DEFAULT_ICON = 'https://ui-avatars.com/api/?name=V&background=6CA5FF&color=FFFFFF&size=216&format=png';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const seg = url.pathname.split('/').filter((s) => s.length > 0);
    const token = env.TOKEN || '';
    if (seg.length === 0) {
      return json({ ok: true, service: 'vhome-meow-relay' });
    }
    if (seg[0] !== token) {
      return json({ ok: false, error: 'bad token' }, 403);
    }
    const action = seg[1] || '';
    try {
      if (action === 'health') {
        return json({ ok: true, offlineMs: OFFLINE_MS });
      }
      if (action === 'bind') {
        return await onBind(request, env);
      }
      if (action === 'beat') {
        return await onBeat(request, env);
      }
      if (action === 'relay') {
        return await onRelay(request, env, ctx);
      }
      if (action === 'hms') {
        return await onHms(request, env);
      }
      if (action === 'hook') {
        return await onImHook(request, env, ctx);
      }
      return json({ ok: false, error: 'unknown action' }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
    }
  },

  /** P394：互动消息代查（wrangler.toml 配 crons 后由平台定时拉起）
   *  P405：去掉 hmsEnabled 门槛 —— 会话凭据上报已不依赖华为推送密钥，
   *  只要有人报过 /hms（现在允许纯会话，t 可空）就代查 */
  async scheduled(controller, env, ctx) {
    const list = await env.VHOME_KV.list({ prefix: 'hms:' });
    for (const key of list.keys) {
      const uid = key.name.slice(4);
      const raw = await env.VHOME_KV.get(key.name);
      if (!raw) {
        continue;
      }
      const h = JSON.parse(raw);
      if (await isOnline(env, uid)) {
        continue;
      }
      try {
        await pollInteractionsFor(env, uid, h);
      } catch (e) {
        console.warn(`[relay] poll uid=${uid}: ${e && e.message}`);
      }
    }
  }
};

/* ==================== 华为 Push（P394） ==================== */

function hmsEnabled(env) {
  return str(env.HMS_CLIENT_SECRET).length > 0;
}

let hmsTokenCache = { token: '', expiresAt: 0 };

/** 服务端 OAuth：client_credentials 取 access_token（isolate 内存缓存至过期前 60s） */
async function getHmsAccessToken(env) {
  if (hmsTokenCache.token && Date.now() < hmsTokenCache.expiresAt) {
    return hmsTokenCache.token;
  }
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: str(env.HMS_CLIENT_ID) || HMS_CLIENT_ID,
    client_secret: str(env.HMS_CLIENT_SECRET)
  });
  const res = await fetch(HMS_OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  const body = await res.text();
  if (res.status !== 200) {
    throw new Error(`oauth ${res.status}: ${body.slice(0, 200)}`);
  }
  const j = JSON.parse(body);
  if (!j.access_token) {
    throw new Error(`oauth no token: ${body.slice(0, 200)}`);
  }
  const ttl = Number(j.expires_in) > 0 ? (Number(j.expires_in) - 60) * 1000 : 3300000;
  hmsTokenCache = { token: j.access_token, expiresAt: Date.now() + ttl };
  return j.access_token;
}

/** 下发华为通知消息（系统通知栏直达，无需 App 进程存活） */
async function sendHms(env, token, title, msg) {
  const access = await getHmsAccessToken(env);
  const payload = {
    validate_only: false,
    message: {
      data: '{"route":"panel","mode":"panel"}',
      notification: {
        title: String(title || 'VHome 消息').slice(0, 40),
        body: String(msg || '').slice(0, 100),
        defaultSound: true,
        clickAction: { type: 1 }
      },
      token: [String(token)]
    }
  };
  const res = await fetch(HMS_PUSH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${access}`
    },
    body: JSON.stringify(payload)
  });
  const body = await res.text();
  // 华为发送接口是异步的：HTTP 200 不代表送达，业务结果在响应体 code（成功 = 80000000）
  let code = '';
  try {
    code = String((JSON.parse(body) || {}).code || '');
  } catch (_) {
  }
  return { http: res.status, body: body.slice(0, 200), ok: res.status === 200 && code === '80000000', code };
}

/** POST /hms { u, t?, s? } —— P405：会话凭据上报（t 可空，不再要求华为 pushToken） */
async function onHms(request, env) {
  const b = await request.json();
  const u = str(b.u);
  if (!u) return json({ ok: false, error: 'no uid' }, 400);
  await env.VHOME_KV.put(`hms:${u}`, JSON.stringify({
    t: str(b.t),
    s: str(b.s),
    at: Date.now()
  }), { expirationTtl: 604800 });
  return json({ ok: true, hms: hmsEnabled(env) ? 'enabled' : 'disabled' });
}

/** 复刻 App 的 starfans 请求签名（ApiClient 同口径） */
async function starfansForm(extra, sess) {
  const params = Object.assign({}, extra, {
    sys_v: '29',
    app_v: '2.6.14',
    terminal: 'android',
    self_userid: sess.userId,
    uvkey: sess.uvkey,
    app_o: '0',
    sysModel: 'HarmonyOS',
    _authOnce: crypto.randomUUID().replace(/-/g, '')
  });
  const keys = Object.keys(params).sort();
  let src = '';
  for (const k of keys) {
    src += `${k}=${params[k]}&`;
  }
  src = src.slice(0, -1) + SIGN_SALT;
  params._authKey = await md5Hex(src);
  return new URLSearchParams(params).toString();
}

/** Web Crypto 无 MD5；Worker 环境下用纯 JS 实现（16 字节摘要） */
async function md5Hex(text) {
  const enc = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('MD5', enc).catch(() => null);
  if (digest) {
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // 兜底：自实现 MD5（Workers 默认不支持 MD5 digest，需要启用兼容标志或引入实现）
  throw new Error('MD5 unsupported: enable nodejs_compat or use the Node server.js');
}

/** 代查一个离线用户的未读数；增量类别经 HMS 下发（基线存 KV：unrd:{uid}） */
/* ==================== P399：互动推送带内容 ==================== */

/** 文本摘要：去标签、压缩空白、截断（推送正文单条上限） */
function brief(s, max = 40) {
  const t = String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** 从列表 JSON 挖数组（对齐 App 端 VaeApi.findList 口径：list/data/result/result.list…） */
function findListArr(parsed) {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }
  const keys = ['list', 'data', 'result', 'items', 'records', 'rows', 'articleList', 'reviewInfo'];
  for (const k of keys) {
    const v = parsed[k];
    if (Array.isArray(v)) {
      return v;
    }
    if (v && typeof v === 'object' && Array.isArray(v.list)) {
      return v.list;
    }
  }
  return [];
}

/** 拉某分类最新列表（签名请求与 unreadNum 同款；失败返回 []，调用方退回纯计数文案） */
async function fetchCategoryItems(sess, path, want) {
  const body = await starfansForm({
    userId: String(sess.userId),
    pageNo: '1',
    pageSize: String(Math.min(Math.max(want, 1), 5))
  }, sess);
  const res = await fetch(`${STARFANS_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      'User-Agent': 'n2.1',
      Accept: 'application/json',
      Cookie: String(sess.cookie || '')
    },
    body
  });
  const j = JSON.parse(await res.text());
  if (!j || j.state !== true) {
    return [];
  }
  return findListArr(j.result !== undefined ? j.result : j);
}

/** 单条互动消息 → 一行摘要（按分类取不同字段；全部走 brief 防超长） */
function digestItem(key, it) {
  const name = brief(it.userName || (it.addUserInfo && it.addUserInfo.userName) || '', 12);
  if (key === 'officialMsgCount') {
    // 实测 title 恒为「系统消息」，正文在 content —— content 优先
    return brief(it.content || it.title);
  }
  if (key === 'reviewMsgCount') {
    return `${name ? name + '：' : ''}${brief(it.content || it.lastContent || it.targetReviewName)}`;
  }
  if (key === 'dingMsgCount') {
    const tgt = it.targetReviewName ? `「${brief(it.targetReviewName, 24)}」` : '你';
    return `${name || '有人'} 赞了${tgt}`;
  }
  if (key === 'attachMsgCount') {
    return `${name ? name + ' ' : ''}@了你：${brief(it.title || it.content)}`;
  }
  return brief(it.content || it.title);
}

async function pollInteractionsFor(env, uid, h) {
  // P405：只要会话凭据就代查（不再要求华为 pushToken）
  if (!h || !h.s) {
    return;
  }
  let sess;
  try {
    sess = JSON.parse(h.s);
  } catch (e) {
    return;
  }
  if (!sess || !sess.userId || !sess.uvkey) {
    return;
  }
  const body = await starfansForm({ userId: String(sess.userId) }, sess);
  const res = await fetch(`${STARFANS_BASE}/MSG/unreadNum.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      'User-Agent': 'n2.1',
      Accept: 'application/json',
      Cookie: String(sess.cookie || '')
    },
    body
  });
  const j = JSON.parse(await res.text());
  if (!j || j.state !== true) {
    return;
  }
  const result = j.result || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const cats = [
    { key: 'officialMsgCount', label: '官方消息', mode: 'official', path: '/MSG/official.json' },
    { key: 'attachMsgCount', label: '@我的', mode: 'atme', path: '/MSG/notifyAt.json' },
    { key: 'reviewMsgCount', label: '评论', mode: 'review', path: '/MSG/review.json' },
    { key: 'dingMsgCount', label: '赞', mode: 'ding', path: '/MSG/ding.json' }
  ];
  const prevRaw = await env.VHOME_KV.get(`unrd:${uid}`);
  const prev = prevRaw ? JSON.parse(prevRaw) : {};
  const next = {};
  const incs = [];
  for (const c of cats) {
    const cur = num(result[c.key]);
    const old = num(prev[c.key]);
    next[c.key] = cur;
    if (prev.built && cur > old) {
      incs.push({ key: c.key, label: c.label, path: c.path, n: cur - old });
    }
  }
  const parts = incs.map((x) => (x.n === 1 ? `1 条新的${x.label}` : `${x.n} 条新的${x.label}`));
  // P398 探针：确认代查真实读到的基线与当前计数
  console.log(`[relay] poll uid=${uid} prev=${JSON.stringify(prev)} cur=${JSON.stringify(next)} parts=${parts.length}`);
  next.built = true;
  // P398：只在基线真变化时回写 —— 原实现每分钟无条件 put，既浪费写配额，
  // 又会覆盖外部对基线的修正（竞态）
  const nextJson = JSON.stringify(next);
  if (nextJson !== prevRaw) {
    await env.VHOME_KV.put(`unrd:${uid}`, nextJson);
  }
  if (incs.length === 0 || (await isOnline(env, uid))) {
    return;
  }
  // P399：带内容 —— 抓增量分类的最新列表，正文形如「评论2条：张三：好看 / 李四：顶」；
  // 抓取失败退回纯计数文案（parts）
  let sendBody = parts.join('、');
  try {
    const segs = [];
    for (const inc of incs.slice(0, 3)) {
      const arr = await fetchCategoryItems(sess, inc.path, inc.n);
      const lines = arr.slice(0, Math.min(inc.n, 3))
        .map((it) => digestItem(inc.key, it || {}))
        .filter((s) => s.length > 0);
      segs.push(lines.length > 0
        ? `${inc.label}${inc.n}条：${lines.join(' / ')}`
        : (parts.find((p) => p.indexOf(inc.label) >= 0) || `${inc.n} 条新的${inc.label}`));
    }
    if (segs.length > 0) {
      sendBody = segs.join('；');
    }
  } catch (e) {
    console.warn(`[relay] 互动内容抓取失败 uid=${uid}: ${e && e.message} → 纯计数`);
  }
  sendBody = sendBody.slice(0, 220);
  // P401：只推传送鸽且 token 必填 —— 未填个人 Token 不推（原 env.PIGEON_TOKEN 兜底已删除）。
  // 正文去链接/口令，开头标「【Vae＋推送】」区分多个 app 的推送
  const single = incs.length === 1 ? incs[0] : null;
  const pTitle = `Vae＋推送：${single ? single.label : '消息'}`;
  const bindRaw = await env.VHOME_KV.get(`bind:${uid}`);
  const bind = bindRaw ? JSON.parse(bindRaw) : null;
  await pushPigeon(env, uid, bind ? bind.p : '', pTitle, `【Vae＋推送】${sendBody}`);
}

/* ==================== 绑定 / 心跳 ==================== */

/** POST /bind { u: IM UserID, m: MeoW 昵称, n: 昵称, i: 头像, g: [群ID], p: 传送鸽 Token } */
async function onBind(request, env) {
  const b = await request.json();
  const u = str(b.u);
  if (!u) return json({ ok: false, error: 'no uid' }, 400);
  const next = {
    m: str(b.m),
    n: str(b.n),
    i: str(b.i),
    g: Array.isArray(b.g) ? b.g.map(str).filter((x) => x) : [],
    p: str(b.p),
    at: Date.now()
  };
  // 群索引：先摘掉旧的，再挂上新的（bind 量很小，读写直接来）
  const prevRaw = await env.VHOME_KV.get(`bind:${u}`);
  if (prevRaw) {
    const prev = JSON.parse(prevRaw);
    if (Array.isArray(prev.g)) {
      for (const gid of prev.g) {
        await unindexGroup(env, gid, u);
      }
    }
  }
  await env.VHOME_KV.put(`bind:${u}`, JSON.stringify(next));
  for (const gid of next.g) {
    await indexGroup(env, gid, u);
  }
  return json({ ok: true, meow: next.m ? 'set' : 'empty', groups: next.g.length });
}

/** POST /beat { u, g?, fg? } —— 心跳；进程被清理后自然停，云端据此判离线 */
async function onBeat(request, env) {
  const b = await request.json();
  const u = str(b.u);
  if (!u) return json({ ok: false, error: 'no uid' }, 400);
  // TTL 7 天：长期不登录的账号自动清理
  await env.VHOME_KV.put(`seen:${u}`, String(Date.now()), { expirationTtl: 604800 });
  return json({ ok: true });
}

/* ==================== 客户端上报 ==================== */

/** POST /relay { f: 发送者, t: 接收者/群ID, isGroup, n: 昵称, i: 头像, msg: 摘要 } */
async function onRelay(request, env, ctx) {
  const b = await request.json();
  const from = str(b.f);
  const to = str(b.t);
  if (!from || !to || from === to) {
    return json({ ok: true, skipped: 'self' });
  }
  const payload = {
    from: from,
    fromName: str(b.n) || (await senderName(env, from)),
    icon: str(b.i) || (await senderIcon(env, from)),
    msg: str(b.msg) || '你有一条新消息'
  };
  if (b.isGroup === true) {
    ctx.waitUntil(pushToGroup(env, to, payload));
  } else {
    ctx.waitUntil(pushToUser(env, to, payload, false));
  }
  return json({ ok: true });
}

/* ==================== 腾讯云 IM 回调 ==================== */

/**
 * 腾讯云 IM 第三方回调入口（URL: https://<域名>/<TOKEN>/hook）。
 * 支持 C2C.CallbackAfterSendMsg（发单聊消息之后）与 Group.CallbackAfterSendMsg。
 * 无论内部成败都必须回 ActionStatus=OK —— 回调失败会让 IM 反复重试。
 */
async function onImHook(request, env, ctx) {
  const body = await request.json();
  const cmd = str(body.CallbackCommand);
  const appid = str(new URL(request.url).searchParams.get('SdkAppid'));
  if (env.SDKAPPID && appid && appid !== String(env.SDKAPPID)) {
    return hookOk('appid mismatch');
  }
  const from = str(body.From_Account);
  const text = digestOf(body.MsgBody);
  if (cmd === 'C2C.CallbackAfterSendMsg') {
    const to = str(body.To_Account);
    if (from && to && from !== to) {
      ctx.waitUntil(pushToUser(env, to, {
        from,
        fromName: await senderName(env, from),
        icon: await senderIcon(env, from),
        msg: text
      }, true));
    }
  } else if (cmd === 'Group.CallbackAfterSendMsg') {
    const gid = str(body.GroupId);
    if (from && gid) {
      ctx.waitUntil(pushToGroup(env, gid, {
        from,
        fromName: await senderName(env, from),
        icon: await senderIcon(env, from),
        msg: text
      }));
    }
  }
  return hookOk('');
}

function hookOk(note) {
  return json({ ActionStatus: 'OK', ErrorInfo: note || '', ErrorCode: 0 });
}

/* ==================== 推送 ==================== */

/** 推给单个用户（单聊）；groupGid 非空表示这是群消息（群 ID，标题/跳转链接按群聊走） */
async function pushToUser(env, uid, payload, fromHook, groupGid) {
  const online = await isOnline(env, uid);
  if (online) {
    return; // 对方的 App 进程活着，他自己会弹本机系统通知 → 不重复
  }
  if (await inCooldown(env, uid)) {
    return;
  }
  if (await isDup(env, fromHook ? `h:${payload.from}:${uid}` : `c:${payload.from}:${uid}`)) {
    return;
  }
  markCooldown(env, uid);
  const bindRaw = await env.VHOME_KV.get(`bind:${uid}`);
  const bind = bindRaw ? JSON.parse(bindRaw) : null;
  // P394：HMS 优先 —— P400 起按需求隐藏（ENABLE_HMS=false），实现保留
  if (ENABLE_HMS && hmsEnabled(env)) {
    const hRaw = await env.VHOME_KV.get(`hms:${uid}`);
    if (hRaw) {
      const h = JSON.parse(hRaw);
      if (h.t) {
        try {
          const r = await sendHms(env, h.t, payload.fromName || '新消息', payload.msg);
          if (r.ok) {
            console.log(`[relay] HMS 已推 → uid=${uid}`);
            return;
          }
          console.warn(`[relay] HMS 失败 uid=${uid} http=${r.http} code=${r.code} → 回落 MeoW`);
        } catch (e) {
          console.warn(`[relay] HMS 异常 uid=${uid}: ${e && e.message} → 回落 MeoW`);
        }
      }
    }
  }
  // P306：MeoW —— P400 起按需求隐藏（ENABLE_MEOW=false），实现保留
  if (ENABLE_MEOW && bind && bind.m) {
    markCooldown(env, uid);
    const r = await sendMeow(env, bind.m, payload.fromName || '新消息', payload.msg, payload.icon);
    // MeoW 官方口径：HTTP 状态码统一 200，**业务结果在响应体 status 字段**
    // （如 {"status":429,"data":false,"msg":"IP限制"}）→ 只看 HTTP 码会把失败当成功。
    if (r.http === 200 && r.biz === 200) {
      console.log(`[relay] MeoW 已推 → ${bind.m}`);
    } else {
      console.warn(`[relay] MeoW 失败 uid=${uid} nick=${bind.m} http=${r.http} biz=${r.biz} body=${r.body}`);
    }
  }
  // P401：传送鸽（云端唯一通道）—— token 必填（未配不推），正文开头标「【Vae＋推送】」
  const isGroupChat = typeof groupGid === 'string' && groupGid.length > 0;
  const pTitle = `Vae＋推送：${isGroupChat ? '群聊' : '私聊'}`;
  const pBody = `【Vae＋推送】${payload.fromName || '新消息'}：${payload.msg}`;
  await pushPigeon(env, uid, bind ? bind.p : '', pTitle, pBody);
}

/** P401：传送鸽推送（libv.cc）—— **token 必填**：只取用户 bind.p，为空直接跳过
 *  （不再回落 env.PIGEON_TOKEN，避免未配置用户收到开发者的推送） */
async function pushPigeon(env, uid, userToken, title, msg) {
  const token = str(userToken);
  if (token.length === 0) {
    return;
  }
  try {
    const fd = new URLSearchParams();
    fd.set('token', token);
    fd.set('title', title);
    fd.set('content', msg);
    const res = await fetch(PIGEON_URL, { method: 'POST', body: fd });
    const body = await res.text();
    let ok = false;
    try {
      ok = res.status === 200 && JSON.parse(body).success === true;
    } catch (_) {
    }
    if (ok) {
      console.log(`[relay] 传送鸽已推 → uid=${uid}：${msg}`);
    } else {
      console.warn(`[relay] 传送鸽失败 uid=${uid} http=${res.status} body=${body.slice(0, 120)}`);
    }
  } catch (e) {
    console.warn(`[relay] 传送鸽异常 uid=${uid}: ${e && e.message}`);
  }
}

async function pushToGroup(env, gid, payload) {
  const raw = await env.VHOME_KV.get(`grp:${gid}`);
  if (!raw) {
    return;
  }
  const members = JSON.parse(raw);
  if (!Array.isArray(members)) {
    return;
  }
  for (const uid of members) {
    if (uid === payload.from) {
      continue;
    }
    await pushToUser(env, uid, {
      from: payload.from,
      fromName: payload.fromName,
      icon: payload.icon,
      msg: payload.msg
    }, false, gid);
  }
}

/** 真正调 MeoW：GET https://api.chuckfang.com/{昵称}/{标题}/{正文}?imgUrl={图标} */
async function sendMeow(env, nick, title, msg, icon) {
  const picked = icon && icon.length > 0 ? icon : DEFAULT_ICON;
  const u = `${MEOW_HOST}/${encodeURIComponent(nick)}/${encodeURIComponent(title)}`
    + `/${encodeURIComponent(msg)}?imgUrl=${encodeURIComponent(picked)}`;
  const res = await fetch(u);
  const body = await res.text();
  return { http: res.status, biz: bizStatusOf(body), body: body.slice(0, 200) };
}

/** 取 MeoW 响应体里的业务码（与 App 侧 NotifyCenter.meowBizStatus 同口径） */
function bizStatusOf(text) {
  try {
    const j = JSON.parse(text);
    const s = Number(j && j.status);
    return Number.isFinite(s) ? s : 0;
  } catch (e) {
    return 0;
  }
}

/* ==================== 工具 ==================== */

async function isOnline(env, uid) {
  const seen = await env.VHOME_KV.get(`seen:${uid}`);
  if (!seen) {
    return false;
  }
  return Date.now() - Number(seen) < OFFLINE_MS;
}

async function inCooldown(env, uid) {
  const ts = Number(await env.VHOME_KV.get(`cool:${uid}`));
  return Number.isFinite(ts) && ts > 0 && Date.now() - ts < COOLDOWN_MS;
}

async function markCooldown(env, uid) {
  // KV TTL 下限 60s，而 COOLDOWN_MS 只有 5s → 改存时间戳、读时判龄（P397 修复：
  // 原 expirationTtl 5 直接被 KV 400 拒绝，pushToUser 在发送前就抛异常，云端推送全断）
  await env.VHOME_KV.put(`cool:${uid}`, String(Date.now()));
}

/** 回调与客户端上报可能描述同一条消息 → 短窗口内只推一次 */
async function isDup(env, sig) {
  const key = `dup:${sig}`;
  if ((await env.VHOME_KV.get(key)) !== null) {
    return true;
  }
  // KV TTL 下限 60s：去重窗口由 12s 放宽到 60s（语义只强不弱；P397 同款修复）
  await env.VHOME_KV.put(key, '1', { expirationTtl: Math.max(60, Math.ceil(DEDUP_MS / 1000)) });
  return false;
}

async function senderName(env, uid) {
  const raw = await env.VHOME_KV.get(`bind:${uid}`);
  if (!raw) {
    return '';
  }
  const b = JSON.parse(raw);
  return str(b.n);
}

async function senderIcon(env, uid) {
  const raw = await env.VHOME_KV.get(`bind:${uid}`);
  if (!raw) {
    return '';
  }
  const b = JSON.parse(raw);
  return str(b.i);
}

async function indexGroup(env, gid, uid) {
  const key = `grp:${gid}`;
  const raw = await env.VHOME_KV.get(key);
  const list = raw ? JSON.parse(raw) : [];
  if (Array.isArray(list) && list.indexOf(uid) < 0) {
    list.push(uid);
    await env.VHOME_KV.put(key, JSON.stringify(list));
  } else if (!Array.isArray(list)) {
    await env.VHOME_KV.put(key, JSON.stringify([uid]));
  }
}

async function unindexGroup(env, gid, uid) {
  const key = `grp:${gid}`;
  const raw = await env.VHOME_KV.get(key);
  if (!raw) {
    return;
  }
  const list = JSON.parse(raw);
  if (!Array.isArray(list)) {
    return;
  }
  const next = list.filter((x) => x !== uid);
  await env.VHOME_KV.put(key, JSON.stringify(next));
}

/** 从 IM 回调的 MsgBody 里取一句人话（文本 / 图片 / 语音 / 视频 / 文件 / 表情 / 自定义） */
function digestOf(msgBody) {
  if (!Array.isArray(msgBody) || msgBody.length === 0) {
    return '你有一条新消息';
  }
  const first = msgBody[0];
  const type = str(first.MsgType);
  const c = first.MsgContent || {};
  if (type === 'TIMTextElem') {
    return str(c.Text) || '你有一条新消息';
  }
  if (type === 'TIMImageElem') return '[图片]';
  if (type === 'TIMSoundElem') return '[语音]';
  if (type === 'TIMVideoFileElem' || type === 'TIMVideoElem') return '[视频]';
  if (type === 'TIMFileElem') return '[文件]';
  if (type === 'TIMFaceElem') return '[表情]';
  if (type === 'TIMLocationElem') return '[位置]';
  if (type === 'TIMCustomElem') return str(c.Desc) || '你有一条新消息';
  return '你有一条新消息';
}

function str(v) {
  if (v === undefined || v === null) {
    return '';
  }
  return String(v).trim();
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
