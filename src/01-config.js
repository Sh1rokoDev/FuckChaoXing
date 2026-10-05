// ========================= 0. 常量与默认配置 =========================

/** 页面选择器集中配置（页面改版时优先调整这里） */
const SEL = {
	catalogLessonRow: "#coursetree .posCatalog_select", // 目录中的行（章节头 + 课时）
	lessonName: ".posCatalog_name", // 课时名（章节头没有）
	lessonUnfinished: "input.jobUnfinishCount", // 课时未完成任务点总数
	currentLessonActive: "posCatalog_active", // 当前课时标记 class
	cardTabs: 'ul.prev_ul li[id^="dct"]', // 课时内卡片标签
	mainIframe: "#iframe", // cards 内容 iframe
	jobIcon: ".ans-job-icon", // 任务点图标
	jobAttach: ".ans-attach-ct", // 任务点容器

	// —— 答题页面（work/index.html 内部的 #frame_content 文档）——
	question: ".TiMu", // 题目容器
	questionType: ".newZy_TItle", // 题型标签（【单选题】…）
	questionStem: ".Zy_TItle .fontLabel", // 题干容器
	questionStemWrap: ".Zy_TItle", // 题干外层（含题号）
	optionList: ".Zy_ulTop, .Zy_ulBottom", // 选项列表
	optionItem: "li", // 选项
	optionLabel: ".num_option", // 选项字母标签
	optionBody: "a", // 选项正文容器
	submitBtn: "a.btnSubmit", // 提交按钮
	saveBtn: "a.btnSave", // 暂时保存按钮
	hiddenIframe: "#frame_content", // 题目文档 iframe（缺失时回退为 work iframe 本身）

	// —— 提交交互弹窗（实测自 /mooc-ans/api/work 文档，保留用于结果识别）——
	confirmWin: "#confirmSubWin", // 确认提交弹窗（脚本不自动点击，仅用于识别）
	verifyWin: "#verifyCodeWin", // 验证码弹窗
	popWin: "#workpop", // 通用提示弹窗（class maskDiv）
	popContent: "#popcontent", // 提示文本
	hintWin: "#hintPop", // 简易提示弹窗
	hintContent: "#hintCon", // 提示文本
};

/** 视频任务点 iframe 特征 */
const URL_VIDEO_MODULE = "/ananas/modules/video/";
/** 答题类任务点 iframe 特征 */
const URL_WORK_MODULE = "/ananas/modules/work/";
const RE_ANSWER_MODULE = /\/ananas\/modules\/(work|quiz|exam)\//;
/** 视频进度上报接口特征 */
const REPORT_URL_KEYWORD = "/multimedia/log/";
/** 任务点已完成 aria-label 关键词（"任务点已完成"，注意"未完成"不含"已完成"） */
const ICON_DONE_KEYWORD = "已完成";
/** 字体混淆使用的 family 名 */
const SECRET_FONT_FAMILY = "font-cxsecret";
/** 混淆字体元素 class */
const SECRET_FONT_CLASS = "font-cxsecret";

/** 运行时行为参数 */
const CFG = {
	cardLoadTimeout: 30000, // 等待卡片 iframe 就绪超时
	videoFindTimeout: 25000, // 等待 video 元素出现超时
	endedGraceTimeout: 20000, // 视频结束后等待任务点状态更新时间
	navTimeout: 40000, // 课时切换等待超时
	maxPauseResumes: 500, // 单任务点恢复播放的绝对上限（兜底；实际由进度看门狗主导）
	noProgressTimeout: 180000, // 视频 currentTime 持续无推进的最长容忍时间（超时判失败）
	maxJobRetries: 2, // 单个任务点重试次数上限
	monitorInterval: 1000, // 监控轮询间隔（兜底，事件驱动为主）
	progressLogInterval: 30000, // 播放进度日志输出间隔
	logMaxCards: 80, // 日志区保留的最大卡片数（超出后淘汰最早的卡片）

	// —— 答题相关 ——
	workDocTimeout: 25000, // 等待题目文档就绪
	workSettleTimeout: 20000, // 等待题目文档内题目渲染完成
	answerFindTimeout: 15000, // 等待题目列表出现
	renderTimeout: 25000, // 单题渲染（含图片加载）超时
	renderWidth: 860, // 渲染容器宽度（px），模拟答题页正文宽度
	renderMaxHeight: 2000, // 单张图最大高度，超出则纵向切分
	renderTileOverlap: 24, // 切分时的重叠像素，避免切断文字
	imageMaxWidth: 900, // 输出图片最大宽度（PNG 无损原图，不做有损压缩）
	llmBatchSize: 1, // 每次请求提交的题目数（逐题作答，定位最清晰）
	llmTimeout: 180000, // 单次 LLM 请求超时
	llmMaxRetries: 3, // LLM 请求失败重试次数
	llmRetryDelay: 2500, // LLM 重试间隔基数（指数退避）
	fillVerifyDelay: 260, // 每次点选后的稳定等待
	tempSaveTimeout: 20000, // 等待「暂时保存」结果
};

/** LLM 默认配置（用户可在面板中修改，持久化到 store） */
const LLM_DEFAULTS = {
	baseUrl: "https://api.openai.com/v1",
	apiKey: "",
	model: "gpt-4o-mini",
	apiStyle: "chat", // chat = /chat/completions，responses = /responses
	temperature: 0.2,
	maxTokens: 2048,
	jsonMode: true, // 优先请求 JSON 输出（服务不支持时自动降级）
	systemPrompt: "", // 留空用内置提示词
	extraHeaders: "", // JSON 文本，如 {"X-Foo":"bar"}
};

/** 支持的题型（仅这三种，其余题型一律跳过） */
const SUPPORTED_TYPES = ["单选", "多选", "判断"];

/** 答题默认配置 */
const ANSWER_DEFAULTS = {
	enabled: true, // 是否处理答题任务点
	autoTempSave: true, // 作答完成后自动点击「暂时保存」暂存答案（提交始终由用户手动完成）
	skipFilled: true, // 已作答的题目跳过
	unknownAction: "skip", // 模型未给出答案时的策略：skip 留空不作答 / guess 随机选一个
	types: { 单选: true, 多选: true, 判断: true }, // 题型勾选（仅支持这三种）
	debugDump: false, // 保存最近一次请求 JSON 到日志（排错用）
};
