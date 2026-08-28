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
| 鼠标滑上去 | 整体轻轻鼓起(弹簧,带过冲),并触发一次表情反应,7~12s 冷却 |
| 拖拽球身 | 移动窗口(位移 > 6px 才算拖拽) |
| 单击 | **说话**:表情 + 气泡台词,连点会越来越不耐烦 |
| 双击 | 撒花 + 高兴的台词 |
| 右键 | 表情菜单 |
| 托盘图标 | 散步 / 自发行为开关 / 表情 / 形态 / 线稿 / 回到右下角 / 退出 |
| 移动鼠标 | 全局注视跟随(主进程轮询光标,球外也跟) |
| 什么都不做 | 它自己会散步、好奇张望、发呆、伸懒腰 |

球身之外的区域鼠标穿透,不挡下面的窗口。

## 它自己会动

**散步(物理版)**:不是等高等距的连续弹跳,而是真的做积分 ——

```
下蹲蓄力 → 蹬地 → 落体 → 落地(垂直速度 ×0.58) → 越弹越低 → 停住 → 歇 0.3~0.7s → 再蹬
```

一次「散步」= 若干次蹬地,每次蹬地内部是一串自然衰减的弹跳。撞到屏幕边缘会反向弹开。
位移做在**窗口层**而不是 SVG 层 —— 引擎的 `ball.bounce()` 是球在窗口内原地弹,
两者叠加会变成双重运动,所以散步期间不调 `bounce()`。

**压缩形变(squash & stretch)**:蓄力压扁 → 蹬地拉长 → 落地压扁 → 回弹过冲 → 余震收敛。
主进程只发事件(蓄力 / 起跳 / 落地冲量 / 收尾),形变本身是渲染进程里一个**欠阻尼弹簧**,
作用在容器的 CSS transform 上,锚点按形态设在**球底**(blob/gem 94%、wedge 90.2%),
不然会变成"悬空压扁"。这样不用改引擎一行代码,也不和引擎自己的 SVG 变换打架。

实测(`tools/probe-squash.mjs` 读 computed transform):

| 时刻 | scaleY | 状态 |
|---|---|---|
| 0.24s | 0.849 | 蓄力压扁 15% |
| 0.36s | 1.060 | 蹬地拉长 |
| 0.72s | 0.880 | 第一次落地 |
| 0.96s | 0.930 | 第二次落地(冲量已衰减) |
| 1.2s+ | →1.000 | 余震收敛 |

调参:物理在 [main.js](main.js) 顶部常量(`GRAV` / `REST` / `LAUNCH_V` / `VX_DAMP`),
形变弹簧在 [renderer/pet.js](renderer/pet.js) 的 `springStep(sq, 26, 0.34, dt)`。

**三段生命周期**(按距上次交互的时长):

| 阶段 | 时长 | 行为 |
|---|---|---|
| 活跃 | 0~45s | 14~26s 一次:散步 / 好奇 / 发呆 / 伸懒腰 / 开心 |
| 发呆 | 45s~150s | 待机;26~48s 一次,主要是溜达 |
| 睡眠 | >150s | `00` 睡眠,不再动;任何交互都会唤醒(播 `01` 唤醒序列) |

> 引擎自带的 idle 策略在创建时关掉了(`idle: false`)。它的 `_checkIdle` 每帧都会把
> 非 `02`/`00` 的表情强行拉回待机,和上面这套调度器并存的话「好奇」「散步」活不过一帧。
> 生命周期由主进程独占。

托盘菜单里可以关掉「自发行为」,或手动触发一次散步。

## 交互反应

点击不再是甩彩带,而是**表情 + 台词**。台词按连击次数分档:

| 连击(6s 内累计) | 语气 | 例 |
|---|---|---|
| 1~2 下 | 正常 | 「有何贵干?」「怎么啦?」「哎哟!吓我一跳」 |
| 3~5 下 | 不耐烦 | 「又是你啊……」「还戳?」「你是不是很闲」 |
| 6~7 下 | 生气 | 「别戳了!」「拒绝服务」 |
| 第 8 下 | 撂狠话后**真的不理你** | 「哼!不说了」「……(装死)」 |

戳满 8 下会进入 **10s 闹脾气冷却**:期间点击、双击、悬停一概**没有任何反应**,也不再自发散步。

观感取决于抽中哪条 sulk 台词:

- `21` 生气 / `38` 拒绝 —— 照常眨眼,看着是在赌气;
- `41` 停止终止 —— 上游把它定义成 `blinkMs: null` + `gaze: false` + `sequence.settle: 'hold'`,
  眼睛收成细线后**定格**,连鼠标都不看。这是「装死」本来就该有的样子。

不想要定格效果,把 [reactions.js](reactions.js) 里 `sulk` 池的两条 `41` 换成 `21` 或 `18`。
冷却结束会自己说一句「……好了,气消了」然后回待机,连击计数归零。

托盘选表情和 HTTP 接口算**控制通道**,不算"戳它",会直接消气。
时长在 [main.js](main.js) 的 `SULK_AT` / `SULK_MS`。

睡着时被点会走另一套(「唔……几点了?」),播 `01` 唤醒序列。
悬停多数只给个眼神,偶尔才出声 —— 免得话痨。

台词全在 [reactions.js](reactions.js),纯数据,随便改。

> 挑台词放在**主进程**,不在渲染进程:主进程独占表情生命周期
> (`setEmotion` + 回落计时),渲染进程自己改表情会被行为调度器覆盖。
> 而且罐头台词和以后大模型生成的台词走的是**同一条管道** ——
> `{emotionId, tips}` → `handleAIMessage` → 表情 + 气泡,接大模型时
> 只需把「挑一条」换成「生成一条」。

## AI 评论(DeepSeek)

它会周期性看一眼你在用什么应用,把「在写代码 / 在玩游戏 / 在看视频」这类**分类**
交给 DeepSeek,换回一句评论,用表情 + 气泡说出来。

### 配置

```bash
cp config.example.json config.local.json
# 编辑 config.local.json 填入 apiKey(或设环境变量 DEEPSEEK_API_KEY)
```

`config.local.json` 已在 `.gitignore` 里,key 不会进仓库。**没配 key 时整个功能静默关闭**,
不报错也不打扰。

| 配置项 | 默认 | 说明 |
|---|---|---|
| `apiKey` | — | DeepSeek key;也可用环境变量 `DEEPSEEK_API_KEY` |
| `model` | `deepseek-chat` | |
| `everyMs` | 600000 | 没别的事发生时,多久评论一次 |
| `minGapMs` | 180000 | 两次调用的**硬下限**,防止切来切去烧额度 |

### 什么时候会说话

- 活动**分类变了**(写代码 → 玩游戏)→ 马上说一句,但受 `minGapMs` 约束;
- 否则每 `everyMs` 一次。

这几种情况一律不说:光标 5 分钟没动(人不在)、正在闹脾气、正在散步、上一句还没说完。
睡着了倒是会醒过来说(但不播唤醒序列,免得白闪一下)。

### 隐私

发出去的**只有应用名和分类**,例如「用户现在在用:Code(看起来在写代码)」。
**不读窗口标题** —— 那里面常有文件路径、文档名、聊天对象。想要更精准的评论可以自己加,
但那是另一个量级的信息暴露,默认不开(见 [activity.js](activity.js) 文件头)。

前台是桌宠自己时会沿用上一个已知应用,不然它会以为你一直在用它。

### 成本

system 提示(含 32 个表情清单)是固定的,DeepSeek 会自动命中上下文缓存。
按默认 10 分钟一次算,一天约 140 次调用,量很小。

### 调试

```bash
curl http://127.0.0.1:17817/activity      # 看它以为你在干嘛(调分类规则用)
curl -X POST http://127.0.0.1:17817/comment   # 手动催一句,返回模型原样结果
```

托盘菜单里有「AI 评论」开关和「现在让它说一句」。

## AI 接口

本地 HTTP,只绑 `127.0.0.1:17817`:

```bash
# 切表情 + 气泡文案
curl -X POST http://127.0.0.1:17817/emotion \
     -d '{"emotionId":"30","tips":"正在思考用户的问题…"}'

# 查全部表情
curl http://127.0.0.1:17817/emotions

# 让它散步(dir: left|right,省略则随机;launches = 蹬几次,默认 4)
curl -X POST http://127.0.0.1:17817/walk -d '{"dir":"left","launches":3}'

# 查当前状态(阶段 / 表情 / 是否在走 / 连击 / AI 状态 / 窗口位置)
curl http://127.0.0.1:17817/state

# 看它以为你在干嘛
curl http://127.0.0.1:17817/activity

# 手动催一句 AI 评论
curl -X POST http://127.0.0.1:17817/comment
```

POST 的 body 原样转给引擎的 `handleAIMessage`,所以未知 ID / 坏 JSON / 缺字段
都会自动回落待机,不会白屏 —— 容错是引擎自带的,这层不做二次解析。

常用 ID:`00` 睡眠 · `02` 待机 · `10` 开心 · `21` 生气 · `30` 思考中 · `33` 任务完成 · `34` 出错 · `40` 检索资料

`50` 散步是本项目在自定义段(`50+`)运行时注册的,不在上游 32 个表情里,也不进菜单。

## 结构

```
main.js              主进程:透明置顶窗 / 光标轮询 / 行为调度 / 交互反应 / 托盘 / HTTP
reactions.js         罐头台词与表情(纯数据)
activity.js          你在干嘛:lsappinfo 取前台应用 + ps 取后台,关键词分类
deepseek.js          DeepSeek 客户端:活动快照 → {emotionId, text}
config.example.json  配置模板(复制成 config.local.json 填 key,已 gitignore)
preload.js           contextBridge 安全桥(contextIsolation 开启)
renderer/
  index.html         按 数据→配置→渲染→驱动 顺序加载引擎四件套
  pet.js             命中检测 / 拖拽点击判定 / 压缩形变弹簧 / 接 AI 消息
  pet.css            全透明壳 + 气泡(窗口 280×240,球 100×100)
tools/
  probe-squash.mjs   读渲染进程 computed transform,调形变手感用
vendor/emotion-ball/ 引擎四件套(从上游仓库复制,含 LICENSE 与 NOTICE)
```

## 授权

引擎与表情数据来自 [sam70361/emotion-ball](https://github.com/sam70361/emotion-ball),
遵循其 [社区许可](vendor/emotion-ball/LICENSE):**个人学习 / 研究免费,禁止商业用途**。
球形角色视觉形象(blob / wedge / gem 造型、配色、彩带特效)**永不提供商业授权**,
详见 [NOTICE.md](vendor/emotion-ball/NOTICE.md)。

本项目仅为个人学习练习,不作任何商业使用。
