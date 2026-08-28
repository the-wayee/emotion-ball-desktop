/* ============================================================
 * deepseek.js —— DeepSeek 客户端
 *
 * 只做一件事：把「你在干嘛」的快照喂给模型，换回一条
 * { emotionId, text } —— 和 reactions.js 里的罐头台词同构，
 * 所以主进程那边 say() 不用区分来源。
 *
 * 两个关键参数，都是踩坑换来的：
 *   thinking: disabled —— DeepSeek v4 系是推理模型，默认先产出几百到两千字的
 *     reasoning_content。为一句 18 字的吐槽思考两千字纯属浪费：实测关掉后
 *     输出 token 从 1323 降到 16、耗时从 12s 降到 0.9s，台词质量没有变差。
 *   max_tokens: 1500 —— 兜底。万一换成不认 thinking 参数的模型，推理照跑，
 *     额度不够就返回空 content + finish_reason=length，表现为"请求失败"。
 *     实测推理能吃掉 1300+ token，给足空间才不会静默失败。
 *
 * 配置统一由 settings.js 管（右键桌宠 → 设置），本文件不自己读文件。
 * 没有 key 就直接返回 null，整个功能静默关闭，不报错也不打扰。
 * ============================================================ */
'use strict';

const settings = require('./settings');

const API = 'https://api.deepseek.com/chat/completions';
const TIMEOUT_MS = 20000;

/** 拼系统提示：把可用表情列表塞进去，模型才知道能选哪些 ID */
function systemPrompt(emotions) {
  const list = emotions
    .filter(e => e.group !== 'custom')
    .map(e => `${e.id}=${e.name}`)
    .join(' ');

  return [
    '你是一只趴在用户桌面角落的小球宠物，会观察用户在电脑上干什么，偶尔冒一句话。',
    '',
    '要求：',
    '1. 只输出 JSON：{"emotionId":"<ID>","text":"<一句话>"}，不要 markdown 代码块。',
    '2. text 用中文，**不超过 18 个字**，气泡很小放不下。',
    '3. 语气像个话不多但有点脾气的小伙伴：可以吐槽、关心、调侃，别像客服，别喊口号，别用感叹号堆热情。',
    '4. 不要每次都问问题，多数时候是自言自语式的一句评论。',
    '5. emotionId 必须从下面这份清单里选：',
    list
  ].join('\n');
}

/** 拼用户消息：当前活动 + 最近说过的话（避免重复） */
function userPrompt(act, recent) {
  /* 分类不出来时别硬套模板 ——「看起来在不太看得出在干嘛」读着很蠢 */
  const lines = [
    act.key === 'unknown'
      ? (act.app ? `用户现在在用：${act.app}` : '看不出用户在用什么应用')
      : `用户现在在用：${act.app || '某个应用'}（看起来在${act.label}）`
  ];
  /* recentApps[0] 就是当前应用，这里只把"之前用的"单独列出来，
   * 免得同一个名字在提示里出现两次 */
  const before = (act.recentApps || []).slice(1);
  if (before.length) {
    lines.push(`在这之前依次用过：${before.join('、')}`);
  }
  const hour = new Date().getHours();
  lines.push(`现在是 ${hour} 点`);
  if (recent && recent.length) {
    lines.push(`你最近说过（别重复）：${recent.map(t => `「${t}」`).join('')}`);
  }
  lines.push('说一句吧。');
  return lines.join('\n');
}

/**
 * 要一条评论。
 * @returns {Promise<{ok:true,result:{id,text}}|{ok:false,reason:string}>}
 *   失败带上人话原因 —— 之前一律返回 null，界面只能显示"请求失败,看终端日志"，
 *   为了排查一个空 content 绕了很大一圈。
 */
async function comment(act, emotions, recent) {
  const key = settings.apiKey();
  if (!key) return { ok: false, reason: '还没填 API Key' };
  const model = settings.load().deepseek.model;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt(emotions) },
          { role: 'user', content: userPrompt(act, recent) }
        ],
        response_format: { type: 'json_object' },
        temperature: 1.3,        /* 官方推荐的「闲聊」档，别太板正 */
        thinking: { type: 'disabled' },
        max_tokens: 1500
      })
    });

    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      console.warn('[deepseek] HTTP', res.status, body);
      let msg = '';
      try { msg = JSON.parse(body).error?.message || ''; } catch (e) { /* 错误体不是 JSON */ }
      const hint = res.status === 401 ? 'API Key 不对'
        : res.status === 402 ? '账户余额不足'
        : res.status === 429 ? '请求太频繁,稍后再试'
        : res.status >= 500 ? 'DeepSeek 服务端出错' : '';
      return { ok: false, reason: `HTTP ${res.status}${hint ? ' · ' + hint : ''}${msg ? ' · ' + msg : ''}` };
    }

    const data = await res.json();
    const choice = data?.choices?.[0];
    const raw = choice?.message?.content;
    if (!raw) {
      /* 空 content 几乎都是推理把额度吃光了 —— 把原因直接说清楚，别让人去翻日志 */
      const think = (choice?.message?.reasoning_content || '').length;
      console.warn('[deepseek] content 为空, finish=', choice?.finish_reason, 'reasoning=', think, '字');
      return {
        ok: false,
        reason: choice?.finish_reason === 'length'
          ? `模型把额度用在推理上了(推理 ${think} 字),没留下正文。换个模型试试`
          : '模型没有返回内容'
      };
    }

    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      console.warn('[deepseek] 返回不是 JSON:', String(raw).slice(0, 120));
      return { ok: false, reason: '模型返回的不是 JSON：' + String(raw).slice(0, 40) };
    }

    const text = String(obj.text || '').trim();
    if (!text) return { ok: false, reason: '模型返回的 JSON 里没有 text 字段' };

    /* 表情 ID 校验放在这里而不是靠引擎兜底：引擎遇到未知 ID 会回落待机，
     * 那样评论文字还在、表情却是待机，看着很怪。这里直接换成一个合理的。 */
    const id = String(obj.emotionId || '').trim();
    const ok = emotions.some(e => e.id === id);
    if (!ok) console.warn('[deepseek] 未知 emotionId:', id, '→ 回落 02');

    return { ok: true, result: { id: ok ? id : '02', text: text.slice(0, 40) } };
  } catch (e) {
    const why = e.name === 'AbortError' ? `超时(${TIMEOUT_MS / 1000}s)` : e.message;
    console.warn('[deepseek] 请求失败:', why);
    return { ok: false, reason: '请求失败：' + why };
  } finally {
    clearTimeout(timer);
  }
}

/** 拉一次可用模型列表，给设置界面的下拉用；失败返回空数组 */
async function listModels() {
  const key = settings.apiKey();
  if (!key) return [];
  try {
    const res = await fetch('https://api.deepseek.com/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return [];
    const d = await res.json();
    return (d.data || []).map(m => m.id).filter(Boolean);
  } catch (e) {
    return [];
  }
}

module.exports = { comment, listModels, systemPrompt, userPrompt };
