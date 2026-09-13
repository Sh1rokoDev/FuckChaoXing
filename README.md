# 学习通视频任务点自动刷课助手

适用于超星学习通（chaoxing.com）学习页面的 Tampermonkey 油猴脚本。自动遍历当前课程课时，仅处理**未完成的视频任务点**（答题/作业等任务点一律跳过），带可拖动悬浮面板与实时日志。

> 基于 2026-09 对实际学习通页面的实地 DOM/网络行为分析实现，非网上脚本移植。

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)
2. Tampermonkey 面板 → 添加新脚本 → 粘贴 `chaoxing-video-autoplayer.user.js` 全部内容并保存
3. 打开任意课程的学习页面（`mooc1.chaoxing.com/mycourse/studentstudy?...`），右上角出现悬浮面板

## 使用

- **开始刷课**：扫描课程目录 → 从当前课时开始逐个处理视频任务点
- **停止刷课**：立即终止定时器/监听/流程，不再自动切课；再次点击开始将从当前页面实际状态续跑
- **自动启动**：进入学习页面后自动开始（持久化保存）
- **静音播放**：视频以静音方式播放（观看时长照常上报）
- 面板可拖动，位置自动记忆

## 处理规则

| 任务点类型              | 行为                                                      |
| ----------------------- | --------------------------------------------------------- |
| 视频任务点（未完成）    | 自动播放 → 监控 → 确认完成后进入下一个                    |
| 视频任务点（已完成）    | 跳过                                                      |
| 答题/作业任务点         | 跳过（预留 LLM 答题接口 `LLMAnswerProvider`，当前不启用） |
| 其他任务点 / 纯答题课时 | 跳过                                                      |

一个课时含多张卡片（如：课程视频 + 章节测验）时会依次扫描每张卡片，只处理其中的视频任务点；视频与答题混排的课时不会因答题任务点而被误判为未完成。

## 实地调研结论（脚本实现依据）

### 页面框架（全部同源，脚本仅运行在顶层窗口 `@noframes`）

```
顶层 studentstudy?chapterId&courseId&clazzid&cpi
 ├─ #coursetree            课程目录（左侧/底部）
 ├─ #mainid > #iframe      → /mooc-ans/knowledge/cards?...&knowledgeid=<课时id>&num=<卡片序号0起>
 │    ├─ .ans-attach-ct.videoContainer
 │    │    ├─ .ans-job-icon.ans-job-video    任务点图标（aria-label=任务点已完成/未完成）
 │    │    └─ iframe.ans-insertvideo-online  → /ananas/modules/video/index.html（VideoJS）
 │    └─ （答题卡片则 iframe → /ananas/modules/work/，图标无 ans-job-video）
 └─ 全局函数: getTeacherAjax(courseId,clazzid,kid,cpi) 切课时 / changeDisplayContent(n,total,...) 切卡片
```

### 关键定位方式（选择器已集中在脚本 `SEL` 配置）

- 课时行：`#coursetree .posCatalog_select` 且含 `.posCatalog_name`（章节头只有 `.posCatalog_title`，据此区分）
- 课时 ID：行元素 `id="cur<knowledgeid>"`；当前课时带 `posCatalog_active`
- 未完成任务点总数：行内 `input.jobUnfinishCount`（仅渲染快照、含测验任务，只用于整课时快速跳过）

### 任务点完成判定链（核心）

```
视频播放 → 每~60s GET /mooc-ans/multimedia/log/a/{cpi}/{enc}?...&playingTime=...
            响应 {"isPassed":false,...}
观看时长 ≥ 90% → 某次上报响应 {"isPassed":true,...}
            → 同步地：卡片内图标 aria-label 由"任务点未完成"→"任务点已完成"
```

脚本按优先级判定完成：

1. **任务点状态**（最终依据）：图标 `aria-label` 变为"已完成"（MutationObserver 事件 + 轮询兜底）
2. **服务端信号**：挂钩视频框 `XMLHttpRequest`，捕获上报响应 `isPassed:true`
3. **兜底**：`video.ended` 且 `currentTime ≥ duration-1.5` 后，再等 20s 任务点状态同步；仍未更新则按视频完成处理并记 WARN

### 实测约束

- 未完成任务点前**拖拽会被回退**、**倍速锁 1x**（`doublespeed:1`），必须真实播放
- 自动播放被浏览器策略拦截时自动降级为静音播放（实测面板点击的手势无法传导进 iframe，静音兜底必然生效）
- **播放中可能出现环境性反复暂停**：实测来源不是 `video.pause()` 调用（元素级挂钩捕获为 0），而是 CDN 抖动（`ERR_ABORTED/ERR_CONNECTION_RESET`）引发的媒体源重载/线路切换，媒体元素可能被替换。脚本不依赖暂停原因，统一检测 `paused` 并自动恢复；判失败依据是**进度看门狗**（currentTime 超过 3 分钟零推进才判失败并重试/跳过），恢复时重新应用静音/倍速
- 视频内弹题（`#topicList`）出现时同样按"暂停"处理：自动恢复播放（答题功能未启用，不计入弹题作答）
- 顶层 `jobUnfinishCount` 与徽标在任务完成瞬间**不会**实时更新，不能作为实时依据

## 异常处理

- 单任务点失败：重试 2 次 → 仍失败记 ERROR → 跳过，继续后续任务点
- 页面/iframe 加载慢：基于状态检测轮询等待（含超时），不用固定延时猜测
- 课时切换：`getTeacherAjax` AJAX 切换；函数缺失时整页跳转兜底
- 停止机制：统一停止信号（Symbol）贯穿所有 `sleep/waitFor`，停止时立即拒绝挂起等待、断开全部 MutationObserver、清理定时器

## 已知边界（当前阶段不做）

- 不自动答题（含视频内弹题；遇到时重试恢复播放，超限跳过）
- 未处理考试、直播等特殊页面
- 目录数据每次启动时从当前页面重新扫描，不持久化课程结构
