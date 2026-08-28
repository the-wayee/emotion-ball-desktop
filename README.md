# Emotion Ball Desktop

基于 [Emotion Ball](https://github.com/sam70361/emotion-ball) 表情引擎的 macOS 桌面宠物。**个人学习用途。**

## 跑起来

```bash
npm install
npm start
```

首次安装若卡在 `Downloading Electron binary...`,项目里的 [.npmrc](.npmrc) 已把二进制源指向 npmmirror;
若仍失败,手动触发一次:

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
```

> ⚠️ **不要在 VS Code 的扩展宿主环境里启动**(比如某些 AI 插件的内置终端)。
> 那里带着 `ELECTRON_RUN_AS_NODE=1`,会让 electron 退化成纯 Node,报
> `Cannot read properties of undefined (reading 'on')`。用系统终端,或者:
> ```bash
> env -u ELECTRON_RUN_AS_NODE npm start
> ```

## 交互

| 操作 | 效果 |
|---|---|
| 拖拽球身 | 移动窗口(位移 > 6px 才算拖拽) |
| 单击 | 自旋甩彩带 |
| 双击 | 撒花 |
| 右键 | 表情菜单 |
| 托盘图标 | 表情 / 形态(blob·wedge·gem)/ 线稿 / 回到右下角 / 退出 |
| 移动鼠标 | 全局注视跟随(主进程轮询光标,球外也跟) |

球身之外的区域鼠标穿透,不挡下面的窗口。

## AI 接口

本地 HTTP,只绑 `127.0.0.1:17817`:

```bash
# 切表情 + 气泡文案
curl -X POST http://127.0.0.1:17817/emotion \
     -d '{"emotionId":"30","tips":"正在思考用户的问题…"}'

# 查全部表情
curl http://127.0.0.1:17817/emotions
```

POST 的 body 原样转给引擎的 `handleAIMessage`,所以未知 ID / 坏 JSON / 缺字段
都会自动回落待机,不会白屏 —— 容错是引擎自带的,这层不做二次解析。

常用 ID:`00` 睡眠 · `02` 待机 · `10` 开心 · `21` 生气 · `30` 思考中 · `33` 任务完成 · `34` 出错 · `40` 检索资料

## 结构

```
main.js              主进程:透明置顶窗 / 光标轮询(注视+拖拽)/ 托盘 / HTTP 接口
preload.js           contextBridge 安全桥(contextIsolation 开启)
renderer/
  index.html         按 数据→配置→渲染→驱动 顺序加载引擎四件套
  pet.js             命中检测 / 拖拽点击判定 / 接 AI 消息
  pet.css            全透明壳 + 气泡
vendor/emotion-ball/ 引擎四件套(从上游仓库复制,含 LICENSE 与 NOTICE)
```

## 授权

引擎与表情数据来自 [sam70361/emotion-ball](https://github.com/sam70361/emotion-ball),
遵循其 [社区许可](vendor/emotion-ball/LICENSE):**个人学习 / 研究免费,禁止商业用途**。
球形角色视觉形象(blob / wedge / gem 造型、配色、彩带特效)**永不提供商业授权**,
详见 [NOTICE.md](vendor/emotion-ball/NOTICE.md)。

本项目仅为个人学习练习,不作任何商业使用。
