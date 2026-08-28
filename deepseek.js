/* ============================================================
 * deepseek.js —— DeepSeek 客户端
 *
 * 只做一件事：把「你在干嘛」的快照喂给模型，换回一条
 * { emotionId, text } —— 和 reactions.js 里的罐头台词同构，
 * 所以主进程那边 say() 不用区分来源。
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
  const lines = [
    `用户现在在用：${act.app || '不知道'}（看起来在${act.label}）`
  ];
  if (act.alsoRunning && act.alsoRunning.length) {
    lines.push(`后台还开着：${act.alsoRunning.join('、')}`);
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
 * @returns {Promise<{id:string, text:string}|null>} 失败一律返回 null，宿主保持安静
 */
async function comment(act, emotions, recent) {
  const key = settings.apiKey();
  if (!key) return null;
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
        max_tokens: 120
      })
    });

    if (!res.ok) {
      console.warn('[deepseek] HTTP', res.status, (await res.text()).slice(0, 200));
      return null;
    }

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content;
    if (!raw) return null;

    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      console.warn('[deepseek] 返回不是 JSON:', String(raw).slice(0, 120));
      return null;
    }

    const text = String(obj.text || '').trim();
    if (!text) return null;

    /* 表情 ID 校验放在这里而不是靠引擎兜底：引擎遇到未知 ID 会回落待机，
     * 那样评论文字还在、表情却是待机，看着很怪。这里直接换成一个合理的。 */
    const id = String(obj.emotionId || '').trim();
    const ok = emotions.some(e => e.id === id);
    if (!ok) console.warn('[deepseek] 未知 emotionId:', id, '→ 回落 02');

    return { id: ok ? id : '02', text: text.slice(0, 40) };
  } catch (e) {
    console.warn('[deepseek] 请求失败:', e.name === 'AbortError' ? '超时' : e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { comment, systemPrompt, userPrompt };
