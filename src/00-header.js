// ==UserScript==
// @name         学习通任务点自动助手（视频 + LLM 自动答题）
// @namespace    cx-auto-assistant
// @version      0.2.0
// @description  自动遍历学习通课程课时：自动播放未完成的视频任务点，并调用多模态大模型自动完成测验/作业任务点（支持文字与图片题目、字体混淆还原）。带可拖动悬浮面板与实时日志。
// @author       Copilot
// @match        *://mooc1.chaoxing.com/mycourse/studentstudy*
// @match        *://mooc1-ans.chaoxing.com/mycourse/studentstudy*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_deleteValue
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * ============================== 调研结论（实现依据） ==============================
 *
 * 1. 页面框架结构（全部同源 mooc1.chaoxing.com，脚本只在顶层运行，直接跨 iframe 访问）：
 *    顶层 studentstudy
 *      └─ iframe#iframe  → /mooc-ans/knowledge/cards?...&knowledgeid=<课时id>&num=<卡片序号0起>
 *           ├─ 视频任务点 iframe  → /ananas/modules/video/index.html（VideoJS 播放器）
 *           └─ 答题任务点 iframe  → /ananas/modules/work/index.html
 *                └─ iframe#frame_content → /mooc-ans/api/work?api=1&workId=...（题目文档）
 *
 * 2. 课程目录（顶层）：
 *    - 课时行: div.posCatalog_select（含 .posCatalog_name 才是课时，含 .posCatalog_title 的是章节头）
 *    - 课时 knowledgeid: 行元素 id = "cur<knowledgeid>"
 *    - 当前课时: 行元素带 class posCatalog_active
 *    - 未完成任务点总数: 行内 input.jobUnfinishCount（仅渲染时快照，不实时更新，仅作快速跳过依据）
 *    - 课时点击导航: 全局函数 getTeacherAjax(courseId, clazzid, knowledgeId, cpi)（AJAX 替换 #mainid，无整页刷新）
 *
 * 3. 课时内卡片（顶层 #mainid 区域）：
 *    - 卡片标签: ul.prev_ul li[id^="dct"]（onclick=changeDisplayContent(n,total,kid,cid,clzid,'')）
 *
 * 4. 任务点（cards 框内）：
 *    - 图标: .ans-job-icon，aria-label = "任务点已完成" / "任务点未完成"（服务端渲染初始即准确，完成时实时翻转 —— 最终依据）
 *    - 视频任务点: 图标带 ans-job-video 类；载体 iframe.ans-insertvideo-online（src 含 /ananas/modules/video/）
 *    - 作业/测验任务点: 载体 iframe src 含 /ananas/modules/work/（data 含 workid/worktype/jobid）
 *    - 任务点容器: .ans-attach-ct；视频内弹题容器: #topicList
 *
 * 5. 视频播放器：
 *    - VideoJS: video#video_html5_api.vjs-tech，直接可用 currentTime / duration / paused / ended / play()
 *    - 进度上报: 每 ~60s GET /mooc-ans/multimedia/log/a/{cpi}/{enc}?...playingTime&duration&clipTime&objectId...
 *      响应 JSON: {"isPassed":bool,...}，isPassed:true 即服务端判定视频任务点完成（观看时长 ≥ 90%）
 *    - 限制: 未完成任务点前拖拽会被回退；倍速锁定 1x
 *
 * 6. 答题页面结构（/ananas/modules/work/ → #frame_content 文档）：
 *    - 题目容器: .TiMu.newTiMu（data 属性为题目序号 0 起）
 *    - 题型: .newZy_TItle 文本（【单选题】/【多选题】/【判断题】/【填空题】/【简答题】…），
 *            选项 li 上 qtype 属性：0=单选 1=多选 2=判断 3=填空 …
 *    - 题干: .Zy_TItle .fontLabel（去掉 .newZy_TItle 部分后的内容）
 *    - 选项: .Zy_ulTop li / .Zy_ulBottom li，选项字母在 .num_option 的 data 属性，
 *            选项内容在 li > a 内（可能是文本，也可能是 <img>）
 *    - 选中状态: li > .num_option 带 check_answer 类 / li[aria-checked=true]
 *    - 作答函数: addChoice(li)（单选分支自动互斥）；多选题同名函数可多次调用
 *    - 提交按钮: a.btnSubmit[onclick=btnBlueSubmit()]；提交前弹出确认窗口
 *    - 题图: 题干与选项中的 <img src="http://p.ananas.chaoxing.com/star3/origin/...">，
 *            页面加载时被浏览器自动升级为 https 同路径，脚本需统一改写为 https 才能绕过混合内容拦截
 *
 * 7. 字体混淆（最关键的反作弊手段）：
 *    - 题目文档自身注入 @font-face { font-family: font-cxsecret; src: url("data:application/font-ttf;charset=utf-8;base64,...") }
 *      字体文件仅约 12KB、36 个字形，且每次页面加载随机生成映射（同一段密文在不同页面渲染出不同明文），
 *      因此无法用静态码表破解，必须把 DOM 按当前页面的字体真实渲染成位图交给多模态模型识别。
 *    - 使用混淆字体的元素带 class "font-cxsecret"（题干 .fontLabel、选项 li 均可能带）。
 *    - 混淆字体只作用于有限字符集，其余字符回退原字体 —— 因此必须逐字体族渲染，不能统一字体。
 *    - 破解思路（本脚本采用）：把题目 DOM 按原样克隆进离屏容器，并在顶层文档注册同名字体，
 *      再基于 Range.getClientRects() + getComputedStyle 的布局结果逐行重绘到 canvas，最后交由多模态 LLM 识别。
 * ========================================================================== */
