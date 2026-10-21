// ==UserScript==
// @name         学习通任务点自动助手（视频 + LLM 自动答题）
// @namespace    cx-auto-assistant
// @version      0.4.0
// @description  自动遍历学习通课程课时：自动播放未完成的视频任务点（自动探测并校验最高可用倍速），并调用多模态大模型自动完成测验/作业任务点（支持文字与图片题目、字体混淆还原）。切课不刷新页面，按课时分组日志，带 WinUI3 风格可拖动 / 可收起悬浮面板。
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
 *    - 限制: 未完成任务点前拖拽会被回退；倍速档位由 playbackRates / 倍速菜单给出，
 *            但部分课程菜单可见却实际禁用（点击提示 rateTip / eryaRateTip 或强制重置为 1x），
 *            因此开启倍速后必须实测校验，不能只看菜单是否存在
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

(function () {
	"use strict";

	// >>> 01-config.js
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
		navSettleDelay: 1200, // 任务点完成后等待站点上报收尾再切课（避免请求/回调被中途掐断）
		maxPauseResumes: 500, // 单任务点恢复播放的绝对上限（兜底；实际由进度看门狗主导）
		noProgressTimeout: 180000, // 视频 currentTime 持续无推进的最长容忍时间（超时判失败）
		videoPopupWait: 300000, // 视频内弹题等待手动作答的最长时间（超时判失败并跳过）
		rateProbeDelay: 350, // 应用倍速后先给播放器留出稳定时间，再开始采样
		rateSettleTimeout: 2600, // 播放状态下持续观察倍速是否被站点收回
		rateReapplyLimit: 2, // 非限制性重置时允许重新应用倍速的次数（超过判定为不支持）
		maxJobRetries: 2, // 单个任务点重试次数上限
		monitorInterval: 1000, // 监控轮询间隔（兜底，事件驱动为主）
		progressLogInterval: 30000, // 播放进度日志输出间隔
		logMaxCards: 220, // 日志区保留的最大卡片数（超出后淘汰最早的卡片）
		// 说明：一次完整运行会为每个课时、每道题各建一张卡片，
		// 跨多个课时容易累积到上百张，因此上限给得较宽，同时避免 DOM 无限增长。

		// —— 答题相关 ——
		workDocTimeout: 25000, // 等待题目文档就绪
		workSettleTimeout: 20000, // 等待题目文档内题目渲染完成
		answerFindTimeout: 15000, // 等待题目列表出现
		renderTimeout: 25000, // 单题渲染（含图片加载）超时
		renderWidth: 860, // 渲染容器宽度（px），模拟答题页正文宽度
		renderMaxHeight: 2000, // 单张图最大高度，超出则纵向切分
		renderTileOverlap: 24, // 切分时的重叠像素，避免切断文字
		imageMaxWidth: 900, // 输出图片最大宽度（PNG 无损原图，不做有损压缩）
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

	/** 视频播放默认配置 */
	const VIDEO_DEFAULTS = {
		autoRate: true, // 自动探测课程允许的最高倍速（应用后实测生效才保留，失败回退 1x）
	};

	/** 答题默认配置 */
	const ANSWER_DEFAULTS = {
		enabled: true, // 是否处理答题任务点
		autoTempSave: true, // 作答完成后自动点击「暂时保存」暂存答案（提交始终由用户手动完成）
		skipFilled: true, // 已作答的题目跳过
		unknownAction: "skip", // 模型未给出答案时的策略：skip 留空不作答 / guess 随机选一个
		types: { 单选: true, 多选: true, 判断: true }, // 题型勾选（仅支持这三种）
		debugDump: false, // 保存最近一次请求 JSON 到日志（排错用）
	};

	// >>> 02-core.js
	// ========================= 1. 存储封装（GM_* 优先，localStorage 兜底） =========================

	function safeParse(s, d) {
		try {
			return JSON.parse(s);
		} catch (e) {
			return d;
		}
	}

	const store = {
		get(k, d) {
			try {
				if (typeof GM_getValue === "function") {
					const v = GM_getValue("cxap_" + k, undefined);
					return v === undefined ? d : typeof v === "string" ? safeParse(v, v) : v;
				}
				const v = localStorage.getItem("cxap_" + k);
				return v == null ? d : safeParse(v, v);
			} catch (e) {
				return d;
			}
		},
		set(k, v) {
			try {
				const s = JSON.stringify(v);
				if (typeof GM_setValue === "function") GM_setValue("cxap_" + k, s);
				else localStorage.setItem("cxap_" + k, s);
			} catch (e) {
				/* 忽略存储失败 */
			}
		},
		/** 读取对象型配置并与默认值合并（保证新增字段有值） */
		config(key, defaults) {
			const raw = this.get(key, null);
			const out = {};
			Object.keys(defaults).forEach((k) => {
				out[k] = defaults[k];
			});
			if (raw && typeof raw === "object") {
				Object.keys(raw).forEach((k) => {
					if (raw[k] !== undefined && raw[k] !== null && raw[k] !== "") out[k] = raw[k];
				});
			}
			return out;
		},
	};

	// ========================= 2. 全局运行状态 =========================

	/** 停止信号（唯一标识，贯穿所有挂起等待） */
	const STOP = Symbol("cxap-stop");

	const S = {
		running: false,
		stopRequested: false,
		status: "未启动",
		lessons: [], // 课程课时列表（按页面顺序）
		lessonIdx: -1, // 当前处理的课时下标
		videoSeen: 0, // 已发现的视频任务点数
		videoDone: 0, // 已确认完成的视频任务点数
		answerSeen: 0, // 已发现的答题任务点数
		answerDone: 0, // 已成功完成的答题任务点数
		taskLabel: "—",
		pending: new Set(), // 挂起的 sleep 项（停止时统一拒绝）
		observers: [], // 当前活跃的 MutationObserver
		panels: [], // 面板等需要随停止清理的节点
	};

	// ========================= 3. 日志 =========================

	const Log = {
		/** 当前日志写入目标卡片（由业务流程切换） */
		_cur: "sys",

		/** 切换日志写入的卡片（不存在则按 opts 创建） */
		use(key, opts) {
			this._cur = key;
			if (opts) Panel.ensureCard(key, opts);
		},
		/** 回到系统信息卡片 */
		useSystem() {
			this._cur = "sys";
			Panel.ensureCard("sys", { kind: "sys", title: "系统信息" });
		},
		/** 更新当前卡片标题与徽标 */
		meta(title, badge, badgeCls, kind) {
			Panel.cardMeta(this._cur, { title, badge, badgeCls, kind });
		},

		push(level, msg) {
			const time = new Date().toTimeString().slice(0, 8);
			const line = "[" + time + "][" + level + "] " + msg;
			try {
				console.log("[学习通助手] " + line);
			} catch (e) {
				/* noop */
			}
			try {
				Panel.cardLine(this._cur, level, msg);
			} catch (e) {
				/* 面板未就绪时忽略 */
			}
		},
		info(m) {
			this.push("INFO", m);
		},
		skip(m) {
			this.push("SKIP", m);
		},
		llm(m) {
			this.push("LLM", m);
		},
		pick(m) {
			this.push("PICK", m);
		},
		warn(m) {
			this.push("WARN", m);
		},
		error(m) {
			this.push("ERROR", m);
		},
		ok(m) {
			this.push("OK", m);
		},
		/** 往当前卡片插入题目缩略图（点击弹出查看，不再在日志内放大） */
		image(dataUrl, caption, tip) {
			try {
				Panel.cardThumb(this._cur, dataUrl, caption, tip);
			} catch (e) {
				/* 面板未就绪时忽略 */
			}
		},
	};

	// ========================= 4. 异步工具（全部感知停止信号） =========================

	function sleep(ms) {
		return new Promise((resolve, reject) => {
			if (S.stopRequested) return reject(STOP);
			const item = { timer: null, reject: null };
			item.reject = reject;
			item.timer = setTimeout(() => {
				S.pending.delete(item);
				resolve();
			}, ms);
			S.pending.add(item);
		});
	}

	/** 轮询等待条件成立（事件驱动之外的兜底手段） */
	async function waitFor(condFn, opts) {
		const timeout = (opts && opts.timeout) || 30000;
		const interval = (opts && opts.interval) || 500;
		const desc = (opts && opts.desc) || "条件";
		const start = Date.now();
		for (;;) {
			if (S.stopRequested) throw STOP;
			let v = null;
			try {
				v = condFn();
			} catch (e) {
				v = null;
			}
			if (v) return v;
			if (Date.now() - start > timeout) throw new Error("等待超时：" + desc);
			await sleep(interval);
		}
	}

	/** 带超时的单次异步操作包装（感知停止信号） */
	function withTimeout(promise, ms, desc) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("超时：" + desc)), ms);
			promise.then(
				(v) => {
					clearTimeout(timer);
					resolve(v);
				},
				(e) => {
					clearTimeout(timer);
					reject(e);
				},
			);
		});
	}

	// >>> 03-dom.js
	// ========================= 5. DOM 与跨 iframe 工具 =========================

	const Dom = {
		toArray(nodes) {
			return Array.prototype.slice.call(nodes || []);
		},

		/** 安全访问 iframe 的 contentDocument（跨域时返回 null） */
		docOf(iframe) {
			try {
				const d = iframe && iframe.contentDocument;
				return d && d.body ? d : null;
			} catch (e) {
				return null;
			}
		},

		/** 安全访问 iframe 的 contentWindow */
		winOf(iframe) {
			try {
				return (iframe && iframe.contentWindow) || null;
			} catch (e) {
				return null;
			}
		},

		/** 在文档中查找符合条件的首个 iframe（可按 src 子串过滤） */
		findIframe(doc, srcSubstr) {
			const list = Dom.toArray(doc.querySelectorAll("iframe"));
			if (!srcSubstr) return list[0] || null;
			return (
				list.find((f) => (f.getAttribute("src") || "").indexOf(srcSubstr) !== -1) ||
				null
			);
		},

		/** 文本规范化：合并空白、去掉零宽字符 */
		normText(s) {
			return String(s == null ? "" : s)
				.replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, "")
				.replace(/\s+/g, " ")
				.trim();
		},

		/** 元素是否处于可见状态（有布局尺寸） */
		isVisible(el) {
			if (!el || !el.getBoundingClientRect) return false;
			const r = el.getBoundingClientRect();
			if (r.width <= 0 || r.height <= 0) return false;
			const win = el.ownerDocument.defaultView;
			const cs = win.getComputedStyle(el);
			return cs.display !== "none" && cs.visibility !== "hidden";
		},

		/** 构造绝对 URL（相对路径按所在文档解析） */
		absUrl(url, baseDoc) {
			if (!url) return "";
			try {
				return new URL(url, (baseDoc || document).baseURI).href;
			} catch (e) {
				return url;
			}
		},

		/** 统一升级为 https，绕过混合内容拦截 */
		httpsUrl(url) {
			return String(url || "").replace(/^http:\/\//i, "https://");
		},

		/**
		 * 在任意文档中查询元素（含 srcDoc 解析失败时的容错）。
		 * 返回 { doc, el } 或 null。
		 */
		query(doc, selector) {
			try {
				const el = doc.querySelector(selector);
				return el ? { doc, el } : null;
			} catch (e) {
				return null;
			}
		},

		/**
		 * 检测子树中是否存在「必须靠位图才能读准」的内容：
		 *  - 图片元素（题干图 / 选项图）
		 *  - 使用混淆字体（font-cxsecret）的文字
		 */
		needsBitmap(rootEl) {
			if (!rootEl) return false;
			if (rootEl.tagName === "IMG") return true;
			if (rootEl.querySelector("img")) return true;
			// 文档内不存在混淆字体时，无需继续做代价较高的计算样式扫描
			if (!FontTools.hasSecretFont(rootEl.ownerDocument)) return false;
			if (FontTools.usesSecretFont(rootEl)) return true;
			// computed style 层面再次确认（应对样式表下发字体、无 class 的情况）
			const win = rootEl.ownerDocument.defaultView;
			const nodes = Dom.toArray(rootEl.querySelectorAll("*"));
			for (const n of nodes) {
				try {
					const cs = win.getComputedStyle(n);
					if (cs.fontFamily && cs.fontFamily.indexOf(SECRET_FONT_FAMILY) !== -1)
						return true;
				} catch (e) {
					/* noop */
				}
			}
			return false;
		},
	};

	// ========================= 6. 字体工具（混淆字体处理） =========================

	const FontTools = {
		_cache: new WeakMap(), // doc → Map(family → dataUrl)

		/** 遍历文档样式表，收集全部 @font-face 的 family → src */
		collectFaces(doc) {
			if (this._cache.has(doc)) return this._cache.get(doc);
			const faces = new Map();
			const sheets = Dom.toArray(doc.styleSheets);
			for (const sh of sheets) {
				let rules = null;
				try {
					rules = sh.cssRules;
				} catch (e) {
					continue; // 跨域样式表
				}
				if (!rules) continue;
				for (const r of Dom.toArray(rules)) {
					const txt = r.cssText || "";
					if (!/^@font-face/i.test(txt)) continue;
					const famM = txt.match(/font-family\s*:\s*["']?([^;"'}]+)/i);
					const srcM = txt.match(/url\(\s*["']?([^"')]+)["']?\s*\)/i);
					if (famM && srcM) {
						const fam = famM[1].trim().replace(/^["']|["']$/g, "");
						if (!faces.has(fam)) faces.set(fam, srcM[1]);
					}
				}
			}
			this._cache.set(doc, faces);
			return faces;
		},

		/** 取指定 family 的字体源（绝对 URL 或 data URL） */
		getFaceSrc(doc, family) {
			return this.collectFaces(doc).get(family) || null;
		},

		/** 是否启用字体混淆（文档中存在 font-cxsecret 字体定义） */
		hasSecretFont(doc) {
			return !!this.getFaceSrc(doc, SECRET_FONT_FAMILY);
		},

		/**
		 * 把文档中的混淆字体注册到顶层文档，便于离屏渲染复现。
		 *
		 * 关键点（踩坑记录）：
		 *  - 不能用 document.fonts.check() 判断「是否已注册」：该方法语义是「字体列表中是否没有待加载的字体」，
		 *    对**完全未注册**的字体族同样返回 true，会导致注册被静默跳过，
		 *    后续 canvas 渲染回退系统字体，把字体混淆后的密文（壋于）原样画出来。改用显式状态表。
		 *  - 混淆字体的映射每次页面加载随机生成，切换卡片后同族名的字体内容会变；
		 *    因此需要按「字体数据指纹」判断复用，变则先 delete 旧的同族 FontFace 再重新 add。
		 */
		_registry: new Map(), // 目标文档 → { fp, family, face }
		registerPromises: new Map(), // 目标文档 → Promise
		/**
		 * 把文档中的混淆字体注册到目标文档（默认顶层），便于离屏渲染复现。
		 * @returns {Promise<string|null>} 成功时返回可用的字体族名，失败返回 null
		 */
		async registerSecretFont(doc, targetDoc) {
			const tgt = targetDoc || document;
			const family = this.resolveSecretFamily(doc);
			if (!family) return null;
			const src = this.getFaceSrc(doc, family);
			if (!src) return null;
			const abs = /^data:/i.test(src) ? src : Dom.absUrl(src, doc);
			const fp = this._fingerprint(abs);

			const cur = this._registry.get(tgt);
			if (cur && cur.fp === fp && cur.family === family && cur.face && cur.face.status === "loaded") {
				return family; // 同一份字体数据，已注册且已加载
			}

			const prev = this.registerPromises.get(tgt);
			if (prev) {
				try {
					await prev;
				} catch (e) {
					/* noop */
				}
				const now = this._registry.get(tgt);
				if (now && now.fp === fp && now.family === family && now.face && now.face.status === "loaded")
					return family;
			}

			const p = this._doRegister(tgt, family, abs, fp, this.resolveProbeText(doc, family));
			this.registerPromises.set(tgt, p);
			try {
				return (await p) ? family : null;
			} finally {
				if (this.registerPromises.get(tgt) === p) this.registerPromises.delete(tgt);
			}
		},

		/** 字体数据指纹（用于识别映射是否发生变化；无需完整哈希，取长度 + 头尾即可稳定区分） */
		_fingerprint(s) {
			const len = s.length;
			return len + ":" + s.slice(0, 96) + ":" + s.slice(-96);
		},

		async _doRegister(tgt, family, abs, fp, probe) {
			// 先移除同族旧字体，避免旧映射继续生效
			try {
				const stale = [];
				tgt.fonts.forEach((f) => {
					if (f.family === family) stale.push(f);
				});
				stale.forEach((f) => {
					try {
						tgt.fonts.delete(f);
					} catch (e) {
						/* noop */
					}
				});
			} catch (e) {
				/* noop */
			}

			const win = tgt.defaultView || window;
			// 方式一：FontFace API + 真实加载结果
			try {
				const face = new win.FontFace(family, 'url("' + abs + '")');
				await face.load();
				tgt.fonts.add(face);
				if (face.status === "loaded") {
					this._registry.set(tgt, { fp, family, face });
					return true;
				}
			} catch (e) {
				/* 落到方式二 */
			}

			// 方式二：注入 @font-face 样式并等待真实可用
			try {
				const style = tgt.createElement("style");
				style.textContent =
					'@font-face{font-family:"' + family + '";src:url("' + abs + '");}';
				(tgt.head || tgt.documentElement).appendChild(style);
				const ok = await this._waitFontUsable(family, probe);
				if (ok) {
					this._registry.set(tgt, { fp, family, face: null });
					return true;
				}
			} catch (e2) {
				/* noop */
			}
			return false;
		},

		/**
		 * 等待字体真正可用于绘制。
		 * 不使用 fonts.check()（对未注册字体返回 true 会造成假阳性），
		 * 而是实际渲染两个探针字符并比较位图：能区分开才说明字体生效。
		 */
		_probeCanvas(fam, text) {
			const c = document.createElement("canvas");
			c.width = 120;
			c.height = 48;
			const ctx = c.getContext("2d", { willReadFrequently: true });
			ctx.fillStyle = "#fff";
			ctx.fillRect(0, 0, c.width, c.height);
			ctx.fillStyle = "#000";
			ctx.font = '32px ' + fam;
			ctx.fillText(text, 4, 36);
			return ctx.getImageData(0, 0, c.width, c.height).data;
		},

		/** 字体是否真的生效：用密文字符在目标字体与系统字体下渲染，位图不同即生效 */
		isFontEffective(fam, probeText) {
			try {
				const f = fam || '"' + SECRET_FONT_FAMILY + '"';
				const a = this._probeCanvas(f, probeText);
				const b = this._probeCanvas('"Microsoft YaHei"', probeText);
				let diff = 0;
				for (let i = 0; i < a.length; i += 4) {
					if (Math.abs(a[i] - b[i]) > 60) diff++;
				}
				return diff > 30;
			} catch (e) {
				return false;
			}
		},

		async _waitFontUsable(family, probe) {
			// 触发加载
			try {
				await document.fonts.load('16px "' + family + '"');
			} catch (e) {
				/* noop */
			}
			const text = probe || "壋于壌壍";
			let tries = 0;
			for (;;) {
				if (this.isFontEffective('"' + family + '"', text)) return true;
				if (++tries > 60) return false;
				await new Promise((r) => setTimeout(r, 50));
			}
		},

		/**
		 * 挑选探针文本：从文档的混淆元素中取真实密文字符，
		 * 这样字体生效性检测才有意义（随便取普通汉字可能本就不在混淆字体的字形集里）。
		 */
		resolveProbeText(doc, family) {
			const cmap = this.getSecretCmap(doc);
			if (!cmap || !cmap.size) return "壋于壌";
			const nodes = Dom.toArray(doc.querySelectorAll("." + SECRET_FONT_CLASS)).slice(0, 80);
			const picked = [];
			const seen = new Set();
			for (const el of nodes) {
				for (const ch of Dom.normText(el.textContent)) {
					const cp = ch.codePointAt(0);
					if (cmap.has(cp) && !seen.has(ch)) {
						seen.add(ch);
						picked.push(ch);
						if (picked.length >= 8) return picked.join("");
					}
				}
			}
			return picked.length ? picked.join("") : "壋于壌";
		},

		/** 元素（或其祖先）是否声明使用混淆字体 */
		usesSecretFont(el) {
			let node = el;
			while (node && node.nodeType === 1) {
				if ((node.className || "").toString().indexOf(SECRET_FONT_CLASS) !== -1)
					return true;
				const fam = node.style && node.style.fontFamily;
				if (fam && fam.indexOf(SECRET_FONT_FAMILY) !== -1) return true;
				node = node.parentElement;
			}
			return false;
		},

		/** 元素实际计算使用的字体族列表（用于识别真实字体族名，避免硬编码失配） */
		computedFamilies(el) {
			try {
				const cs = el.ownerDocument.defaultView.getComputedStyle(el);
				return String(cs.fontFamily || "")
					.split(",")
					.map((s) => s.trim().replace(/^["']|["']$/g, ""))
					.filter(Boolean);
			} catch (e) {
				return [];
			}
		},

		/**
		 * 解析文档中真正用于混淆的字体族名。
		 * 优先取 .font-cxsecret 元素计算样式里「文档确实定义了 @font-face」的第一个族名，
		 * 这样即使页面改了字体族名也能正确识别。
		 */
		_familyCache: new WeakMap(),
		resolveSecretFamily(doc) {
			if (this._familyCache.has(doc)) return this._familyCache.get(doc);
			const faces = this.collectFaces(doc);
			let fam = null;
			const nodes = Dom.toArray(doc.querySelectorAll("." + SECRET_FONT_CLASS));
			if (!nodes.length) {
				const body = doc.body;
				if (body) nodes.push(body);
			}
			for (const el of nodes.slice(0, 40)) {
				for (const f of this.computedFamilies(el)) {
					if (faces.has(f)) {
						fam = f;
						break;
					}
				}
				if (fam) break;
			}
			if (!fam && faces.has(SECRET_FONT_FAMILY)) fam = SECRET_FONT_FAMILY;
			this._familyCache.set(doc, fam);
			return fam;
		},

		/** 文档中混淆字体的数据源（按其真实族名解析） */
		secretFontSrc(doc) {
			const fam = this.resolveSecretFamily(doc);
			return fam ? this.getFaceSrc(doc, fam) : null;
		},

		/** 是否启用字体混淆 */
		hasSecretFont(doc) {
			return !!this.secretFontSrc(doc);
		},

		// ============ TTF cmap 解析（用于精确判断「哪些字符被混淆」） ============

		_b64ToBuf(b64) {
			const clean = b64.replace(/\s+/g, "");
			const bin = atob(clean);
			const buf = new ArrayBuffer(bin.length);
			const u8 = new Uint8Array(buf);
			for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
			return buf;
		},

		/** 解析 TTF/OTF 的 cmap，返回该字体覆盖的码点集合 */
		parseCmap(buf) {
			const dv = new DataView(buf);
			if (dv.byteLength < 12) return new Set();
			const numTables = dv.getUint16(4);
			let cmapOff = 0;
			for (let i = 0; i < numTables; i++) {
				const rec = 12 + i * 16;
				if (rec + 16 > dv.byteLength) break;
				const tag =
					String.fromCharCode(dv.getUint8(rec)) +
					String.fromCharCode(dv.getUint8(rec + 1)) +
					String.fromCharCode(dv.getUint8(rec + 2)) +
					String.fromCharCode(dv.getUint8(rec + 3));
				if (tag === "cmap") {
					cmapOff = dv.getUint32(rec + 8);
					break;
				}
			}
			const out = new Set();
			if (!cmapOff || cmapOff + 4 > dv.byteLength) return out;
			const n = dv.getUint16(cmapOff + 2);
			for (let i = 0; i < n; i++) {
				const rec = cmapOff + 4 + i * 8;
				if (rec + 8 > dv.byteLength) break;
				const off = cmapOff + dv.getUint32(rec + 4);
				if (off + 4 > dv.byteLength) continue;
				const fmt = dv.getUint16(off);
				try {
					if (fmt === 4) this._fmt4(dv, off, out);
					else if (fmt === 12) this._fmt12(dv, off, out);
				} catch (e) {
					/* 单个子表解析失败不影响其它 */
				}
			}
			return out;
		},

		_fmt4(dv, off, out) {
			const segX2 = dv.getUint16(off + 6);
			const seg = segX2 / 2;
			const endBase = off + 14;
			const startBase = endBase + segX2 + 2;
			const deltaBase = startBase + segX2;
			const rangeBase = deltaBase + segX2;
			if (rangeBase + segX2 > dv.byteLength) return;
			for (let s = 0; s < seg; s++) {
				const end = dv.getUint16(endBase + s * 2);
				const start = dv.getUint16(startBase + s * 2);
				const delta = dv.getInt16(deltaBase + s * 2);
				const ro = dv.getUint16(rangeBase + s * 2);
				if (start === 0xffff) continue;
				for (let c = start; c <= end; c++) {
					if (ro === 0) {
						out.add((c + delta) & 0xffff);
					} else {
						const gi = rangeBase + s * 2 + ro + (c - start) * 2;
						if (gi + 1 < dv.byteLength && dv.getUint16(gi)) out.add((c + delta) & 0xffff);
					}
				}
			}
		},

		_fmt12(dv, off, out) {
			if (off + 16 > dv.byteLength) return;
			const nGroups = dv.getUint32(off + 12);
			for (let i = 0; i < nGroups; i++) {
				const b = off + 16 + i * 12;
				if (b + 12 > dv.byteLength) return;
				const s = dv.getUint32(b),
					e = dv.getUint32(b + 4);
				if (e < s || e - s > 0x40000) continue;
				for (let c = s; c <= e; c++) out.add(c);
			}
		},

		_cmapCache: new Map(), // 字体数据指纹 → Set(码点)
		/** 取混淆字体覆盖的码点集合（按字体数据指纹缓存） */
		getSecretCmap(doc) {
			const src = this.secretFontSrc(doc);
			if (!src) return null;
			const abs = /^data:/i.test(src) ? src : Dom.absUrl(src, doc);
			const fp = this._fingerprint(abs);
			if (this._cmapCache.has(fp)) return this._cmapCache.get(fp);
			let set = null;
			try {
				// 注意：data URL 形如 data:application/font-ttf;charset=utf-8;base64,AAAA...
				// 中间的 charset 段不能简单用 [^;,]* 匹配，否则解析失败
				const m = abs.match(/^data:[^,]*?;base64,(.*)$/is);
				if (m) set = this.parseCmap(this._b64ToBuf(m[1]));
			} catch (e) {
				set = null;
			}
			if (set) this._cmapCache.set(fp, set);
			return set;
		},

		/** 取题目文本中被混淆的字符（DOM 里是密文，字体渲染后才是明文） */
		cipherCharsIn(doc, text) {
			const cmap = this.getSecretCmap(doc);
			if (!cmap || !text) return [];
			const seen = new Set();
			const out = [];
			for (const ch of String(text)) {
				const cp = ch.codePointAt(0);
				if (cmap.has(cp) && !seen.has(ch)) {
					seen.add(ch);
					out.push(ch);
				}
			}
			return out;
		},
	};

	// >>> 04-panel.js
	// ========================= 7. 悬浮控制面板（Shadow DOM 隔离，WinUI3 / Fluent 风格） =========================

	const Panel = (function () {
		let host = null,
			root = null,
			el = {};

		const HTML = `
	      <style>
	        :host { all: initial; color-scheme: light dark; }
	        * { box-sizing: border-box; margin: 0; padding: 0;
	            font-family: "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI",
	                         "Microsoft YaHei", "PingFang SC", sans-serif; }

	        .panel {
	          --font: "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI",
	                  "Microsoft YaHei", "PingFang SC", sans-serif;
	          --mono: "Cascadia Mono", "Consolas", "SFMono-Regular", monospace;
	          --bg: rgba(243, 243, 243, .90);
	          --card: rgba(255, 255, 255, .72);
	          --card-solid: #ffffff;
	          --stroke: rgba(0, 0, 0, .075);
	          --stroke-strong: rgba(0, 0, 0, .16);
	          --text: #1b1b1b;
	          --text-2: #5c5c5c;
	          --text-3: #8b8b8b;
	          --accent: #0067c0;
	          --accent-hover: #1975c5;
	          --accent-pressed: #005a9e;
	          --accent-text: #ffffff;
	          --accent-soft: rgba(0, 103, 192, .10);
	          --accent-2: #7a5af8;
	          --accent-2-soft: rgba(122, 90, 248, .14);
	          --success: #0f7b0f;
	          --warn: #9d5d00;
	          --error: #c42b1c;
	          --ok-soft: rgba(15, 123, 15, .12);
	          --warn-soft: rgba(157, 93, 0, .12);
	          --err-soft: rgba(196, 43, 28, .12);
	          --hover: rgba(0, 0, 0, .045);
	          --track: rgba(0, 0, 0, .10);
	          --inset: rgba(255, 255, 255, .55);
	          --shadow: 0 24px 64px rgba(0, 0, 0, .24), 0 2px 8px rgba(0, 0, 0, .12);

	          width: min(680px, calc(100vw - 20px));
	          background: var(--bg);
	          backdrop-filter: blur(40px) saturate(1.5);
	          -webkit-backdrop-filter: blur(40px) saturate(1.5);
	          border: 1px solid var(--stroke);
	          border-radius: 8px;
	          overflow: hidden;
	          box-shadow: var(--shadow);
	          color: var(--text);
	          font-size: 12px;
	          line-height: 1.4;
	          position: relative;
	          cursor: move;
	          -webkit-font-smoothing: antialiased;
	        }

	        .panel.dragging, .panel.dragging * { cursor: grabbing !important;
	                                             user-select: none !important; }

	        /* 收起态：圆形悬浮按钮 */
	        .fab { display: none; position: absolute; inset: 0; z-index: 3;
	               align-items: center; justify-content: center; border: 0;
	               border-radius: 50%; background: transparent; color: var(--accent-text);
	               cursor: pointer; }
	        .fab svg { width: 20px; height: 20px; display: block; margin-left: 2px; }
	        .panel.collapsed { width: 54px; height: 54px; border-radius: 50%;
	                           background: var(--accent); border-color: transparent;
	                           backdrop-filter: none; -webkit-backdrop-filter: none;
	                           box-shadow: 0 8px 24px rgba(0, 103, 192, .34),
	                                       0 2px 6px rgba(0, 0, 0, .18);
	                           cursor: pointer; }
	        .panel.collapsed:hover { background: var(--accent-hover); }
	        .panel.collapsed .shell { display: none; }
	        .panel.collapsed .fab { display: flex; }

	        /* 收起按钮（与日志标题同一水平线，带边框的方形按钮） */
	        .collapse { position: absolute; top: 12px; right: 12px; z-index: 6;
	                    width: 28px; height: 28px; border: 1px solid var(--stroke);
	                    border-radius: 6px; display: flex; align-items: center;
	                    justify-content: center; background: var(--card);
	                    color: var(--text-2); cursor: pointer;
	                    transition: background .12s, color .12s, border-color .12s; }
	        .collapse:hover { background: var(--hover); border-color: var(--stroke-strong);
	                          color: var(--text); }
	        .collapse svg { width: 12px; height: 12px; display: block; }
	        .shell { position: relative; transition: opacity .12s ease; }
	        .panel.collapsing { background: var(--accent); border-color: transparent;
	                            box-shadow: 0 8px 24px rgba(0, 103, 192, .34),
	                                        0 2px 6px rgba(0, 0, 0, .18);
	                            transition: background-color .18s ease, border-color .18s ease; }
	        .panel.collapsing .shell { opacity: 0; }
	        .panel.expanding .shell { opacity: 0; }
	        .panel.expanding { transition: background-color .18s ease, border-color .18s ease; }

	        /* 主体两栏 */
	        .body { display: flex; align-items: stretch; height: 442px; }
	        .col-left { width: 308px; flex: 0 0 auto; padding: 12px 12px 14px;
	                    display: flex; flex-direction: column; gap: 10px;
	                    border-right: 1px solid var(--stroke); overflow-y: auto;
	                    scrollbar-width: thin; scrollbar-color: var(--stroke-strong) transparent; }
	        .col-left::-webkit-scrollbar { width: 4px; }
	        .col-left::-webkit-scrollbar-thumb { background: var(--stroke-strong); border-radius: 2px; }
	        .col-left::-webkit-scrollbar-track { background: transparent; }
	        .col-right { flex: 1 1 auto; min-width: 0; padding: 12px;
	                     display: flex; flex-direction: column; }

	        /* 控制台卡片（状态 + 主操作） */
	        .dock { background: var(--card); border: 1px solid var(--stroke);
	                border-radius: 10px; overflow: hidden;
	                box-shadow: inset 0 1px 0 var(--inset), 0 1px 2px rgba(0,0,0,.03); }
	        .dock[data-state="p-run"] { background: linear-gradient(180deg, var(--ok-soft), var(--card) 64%); }
	        .dock[data-state="p-wait"] { background: linear-gradient(180deg, var(--warn-soft), var(--card) 64%); }
	        .dock[data-state="p-err"] { background: linear-gradient(180deg, var(--err-soft), var(--card) 64%); }
	        .dock[data-state="p-done"] { background: linear-gradient(180deg, var(--accent-soft), var(--card) 64%); }
	        .dock-top { display: flex; align-items: center; gap: 8px; padding: 10px 12px 8px;
	                    cursor: move; user-select: none; }
	        .statline { display: flex; align-items: center; gap: 8px; flex: 1 1 auto; min-width: 0; }
	        .pill { display: inline-flex; align-items: center; gap: 6px; height: 22px;
	                padding: 0 9px; border-radius: 999px; font-size: 10.5px;
	                font-weight: 600; flex: 0 0 auto; white-space: nowrap; }
	        .pill i { width: 6px; height: 6px; border-radius: 50%; background: currentColor;
	                  display: block; }
	        .p-idle { background: var(--track); color: var(--text-2); }
	        .p-run { background: var(--ok-soft); color: var(--success); }
	        .p-wait { background: var(--warn-soft); color: var(--warn); }
	        .p-err { background: var(--err-soft); color: var(--error); }
	        .p-done { background: var(--accent-soft); color: var(--accent); }
	        .p-run i { animation: pulse 1.6s ease-in-out infinite; }
	        @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: .28 } }
	        .curtask { flex: 1 1 auto; min-width: 0; text-align: right; font-size: 10.5px;
	                   color: var(--text-3); overflow: hidden; text-overflow: ellipsis;
	                   white-space: nowrap; }

	        /* 主按钮 */
	        .mainbtn { width: 100%; height: 36px; border: 0; border-radius: 4px;
	                   cursor: pointer; font-size: 12.5px; font-weight: 600;
	                   font-family: var(--font); letter-spacing: .2px;
	                   transition: background .12s, transform .06s, box-shadow .12s;
	                   background: var(--accent); color: var(--accent-text);
	                   box-shadow: 0 2px 6px rgba(0, 103, 192, .26); }
	        .mainbtn:hover { background: var(--accent-hover); }
	        .mainbtn:active { background: var(--accent-pressed); transform: translateY(1px); }
	        .mainbtn.stop { background: var(--error); color: #fff;
	                        box-shadow: 0 2px 6px rgba(196, 43, 28, .26); }
	        .mainbtn.stop:hover { filter: brightness(1.08); }
	        .mainbtn:focus-visible, .collapse:focus-visible {
	          outline: 2px solid var(--accent); outline-offset: 1px; }

	        /* 分区标题 */
	        .sect { display: flex; align-items: center; gap: 7px; min-height: 18px; }
	        .sect .st { flex: 0 0 auto; font-size: 11.5px; font-weight: 600;
	                    color: var(--text); display: flex; align-items: center; }
	        .sect .st::before { content: ""; width: 3px; height: 12px; border-radius: 2px;
	                            background: var(--accent); margin-right: 7px; }

	        /* 操作区 */
	        .dock-actions { display: flex; align-items: stretch; gap: 8px;
	                        padding: 0 10px 10px; }
	        .dock-actions .mainbtn { flex: 1 1 auto; width: auto; }
	        .iconbtn { position: relative; width: 36px; height: 36px; flex: 0 0 auto;
	                   display: flex; align-items: center; justify-content: center;
	                   border: 1px solid var(--stroke-strong); border-radius: 4px;
	                   background: var(--card); color: var(--text-2); cursor: pointer;
	                   transition: background .12s, color .12s, border-color .12s; }
	        .iconbtn:hover { background: var(--hover); color: var(--text); }
	        .iconbtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
	        .iconbtn svg { width: 17px; height: 17px; display: block; }
	        .iconbtn .dot { position: absolute; top: 6px; right: 6px; width: 6px; height: 6px;
	                        border-radius: 50%; background: var(--error);
	                        box-shadow: 0 0 0 2px var(--card); }
	        .iconbtn .dot.ok { background: var(--success); }

	        /* 开关（WinUI 设置卡片） */
	        .switches { display: flex; flex-direction: column; overflow: hidden;
	                    flex: 1 1 auto;
	                    background: var(--card); border: 1px solid var(--stroke);
	                    border-radius: 8px; box-shadow: inset 0 1px 0 var(--inset); }
	        .sw { display: flex; align-items: center; gap: 9px;
	              flex: 1 1 0; min-height: 38px; padding: 0 12px;
	              cursor: pointer; user-select: none; color: var(--text-2);
	              font-size: 11px; transition: background .12s, color .12s; }
	        .sw + .sw { border-top: 1px solid var(--stroke); }
	        .sw:hover { background: var(--hover); color: var(--text); }
	        .sw .swlead { width: 24px; height: 24px; border-radius: 6px; flex: 0 0 auto;
	                      display: flex; align-items: center; justify-content: center;
	                      background: var(--track); color: var(--text-2); }
	        .sw:hover .swlead { color: var(--accent); }
	        .sw .swlead svg { width: 14px; height: 14px; display: block; }
	        .sw .swlabel { flex: 1 1 auto; min-width: 0; }
	        .sw input { position: absolute; opacity: 0; pointer-events: none; }
	        .sw .track { width: 40px; height: 20px; border-radius: 10px; flex: 0 0 auto;
	                     position: relative; background: transparent;
	                     border: 1px solid var(--stroke-strong);
	                     transition: background .15s, border-color .15s; }
	        .sw .track::after { content: ""; position: absolute; top: 3px; left: 3px;
	                            width: 12px; height: 12px; border-radius: 50%;
	                            background: var(--text-2);
	                            transition: transform .15s cubic-bezier(.2,0,0,1),
	                                        background .15s; }
	        .sw input:checked + .track { background: var(--accent); border-color: var(--accent); }
	        .sw input:checked + .track::after { transform: translateX(20px);
	                                            background: var(--accent-text); }
	        .sw input:focus-visible + .track { outline: 2px solid var(--accent); outline-offset: 2px; }

	        /* 日志 */
	        .loghd { display: flex; align-items: center; justify-content: space-between;
	                 height: 28px; margin-bottom: 8px; padding-right: 40px; flex: 0 0 auto; }
	        .loghd .st { flex: 0 0 auto; font-size: 11.5px; font-weight: 600; color: var(--text);
	                     display: flex; align-items: center; }
	        .loghd .st::before { content: ""; width: 3px; height: 12px; border-radius: 2px;
	                             background: var(--accent); margin-right: 7px; }
	        .loghd .lessonprog { flex: 1 1 auto; min-width: 0; margin-left: 10px;
	                             text-align: right; font-size: 10px; color: var(--text-3);
	                             overflow: hidden; text-overflow: ellipsis;
	                             white-space: nowrap; font-variant-numeric: tabular-nums; }
	        .log { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding-right: 2px;
	               display: flex; flex-direction: column; gap: 7px; cursor: auto;
	               scrollbar-width: thin; scrollbar-color: var(--stroke-strong) transparent; }
	        .log:empty::before { content: "暂无运行日志"; margin: auto; color: var(--text-3);
	                             font-size: 11px; }
	        .log::-webkit-scrollbar { width: 5px; }
	        .log::-webkit-scrollbar-thumb { background: var(--stroke-strong); border-radius: 3px; }
	        .log::-webkit-scrollbar-track { background: transparent; }

	        /* 卡片 */
	        .card { background: var(--card); border: 1px solid var(--stroke);
	                border-radius: 6px; overflow: hidden; flex: 0 0 auto;
	                box-shadow: 0 1px 2px rgba(0,0,0,.035); }
	        .card .chd { display: flex; align-items: center; gap: 7px; padding: 6px 9px;
	                     border-bottom: 1px solid var(--stroke);
	                     background: linear-gradient(180deg, rgba(255,255,255,.22), transparent); }
	        .card .chd .bar { width: 3px; height: 11px; border-radius: 2px; flex: 0 0 auto;
	                          background: var(--text-3); }
	        .card.video .chd .bar { background: var(--accent); }
	        .card.job .chd .bar { background: var(--accent-2); }
	        .card.q .chd .bar { background: #0f7b0f; }
	        .card .chd .ctitle { flex: 1 1 auto; min-width: 0; font-size: 10.5px;
	                             font-weight: 600; color: var(--text); overflow: hidden;
	                             text-overflow: ellipsis; white-space: nowrap; }
	        .card .chd .cbadge { flex: 0 0 auto; height: 17px; padding: 0 7px; border-radius: 999px;
	                             display: inline-flex; align-items: center; font-size: 9.5px;
	                             font-weight: 600; background: var(--track); color: var(--text-2); }
	        .card .chd .cbadge.ok { background: var(--ok-soft); color: var(--success); }
	        .card .chd .cbadge.err { background: var(--err-soft); color: var(--error); }
	        .card .chd .cbadge.run { background: var(--accent-soft); color: var(--accent); }
	        .card .cbody { padding: 6px 9px 8px; }
	        .card .cbody:empty { display: none; }

	        .cline { display: flex; gap: 7px; line-height: 1.55; font-size: 10.5px;
	                 font-family: var(--mono); word-break: break-all; }
	        .cline .ts { flex: 0 0 auto; padding-top: 1px; font-size: 9.5px;
	                     color: var(--text-3); opacity: .72; }
	        .cline .tx { flex: 1 1 auto; min-width: 0; white-space: pre-wrap;
	                     color: var(--text-2); }
	        .cline.INFO .tx { color: #15803d; }
	        .cline.SKIP .tx { color: #2563eb; }
	        .cline.WARN .tx { color: #b45309; }
	        .cline.ERROR .tx { color: #dc2626; }
	        .cline.OK .tx { color: #0f766e; font-weight: 600; }
	        .cline.LLM .tx { color: #7c3aed; }
	        .cline.PICK .tx { color: #0e7490; }

	        /* 题目缩略图 */
	        .thumb { display: flex; gap: 8px; align-items: center; margin-bottom: 6px;
	                 padding: 6px; background: var(--accent-soft);
	                 border: 1px solid transparent; border-radius: 6px; cursor: pointer;
	                 transition: background .12s, border-color .12s; }
	        .thumb:hover { border-color: rgba(0, 103, 192, .35); }
	        .thumb img { width: 76px; height: 42px; object-fit: cover; object-position: top left;
	                     border-radius: 4px; border: 1px solid var(--stroke); flex: 0 0 auto;
	                     background: #fff; }
	        .thumb .tt { flex: 1 1 auto; min-width: 0; color: var(--accent); font-size: 10.5px;
	                     font-weight: 600; line-height: 1.4; }
	        .thumb .tt small { display: block; color: var(--text-3); font-weight: 400;
	                           font-size: 9.5px; margin-top: 1px; }

	        /* 图片查看弹窗 */
	        .imgmask { position: absolute; inset: 0; z-index: 100; padding: 18px;
	                   display: flex; align-items: center; justify-content: center;
	                   background: rgba(20, 20, 20, .55); cursor: default;
	                   backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
	        .imgmask .box { display: flex; flex-direction: column; max-width: 100%; max-height: 100%;
	                        background: var(--card-solid, #fff); border-radius: 8px; overflow: hidden;
	                        border: 1px solid var(--stroke);
	                        box-shadow: 0 24px 60px rgba(0,0,0,.4); }
	        .imgmask .bh { display: flex; align-items: center; gap: 8px; height: 38px;
	                       padding: 0 8px 0 12px; border-bottom: 1px solid var(--stroke); }
	        .imgmask .bh .bt { flex: 1 1 auto; font-size: 11px; font-weight: 600;
	                           color: var(--text); overflow: hidden; text-overflow: ellipsis;
	                           white-space: nowrap; }
	        .imgmask .bh .bx { width: 30px; height: 26px; border-radius: 4px; cursor: pointer;
	                           display: flex; align-items: center; justify-content: center;
	                           color: var(--text-2); font-size: 16px; }
	        .imgmask .bh .bx:hover { background: var(--err-soft); color: var(--error); }
	        .imgmask .bb { overflow: auto; padding: 8px; background: #fff; }
	        .imgmask .bb img { display: block; width: 100%; background: #fff; }

	        @media (max-width: 640px) {
	          .body { flex-direction: column; height: auto; max-height: 76vh; overflow-y: auto; }
	          .col-left { width: auto; border-right: 0; border-bottom: 1px solid var(--stroke);
	                      overflow: visible; }
	          .col-right { flex: 0 0 auto; height: 244px; }
	        }

	        @media (prefers-color-scheme: dark) {
	          .panel {
	            --bg: rgba(32, 32, 32, .90);
	            --card: rgba(255, 255, 255, .055);
	            --card-solid: #2b2b2b;
	            --stroke: rgba(255, 255, 255, .085);
	            --stroke-strong: rgba(255, 255, 255, .20);
	            --text: #f3f3f3;
	            --text-2: #c7c7c7;
	            --text-3: #9a9a9a;
	            --accent: #60cdff;
	            --accent-hover: #7fd8ff;
	            --accent-pressed: #4cc2ff;
	            --accent-text: #003a4d;
	            --accent-soft: rgba(96, 205, 255, .14);
	            --accent-2: #b69df8;
	            --accent-2-soft: rgba(182, 157, 248, .16);
	            --success: #6ccb5f;
	            --warn: #f0b45a;
	            --error: #ff99a4;
	            --ok-soft: rgba(108, 203, 95, .16);
	            --warn-soft: rgba(240, 180, 90, .16);
	            --err-soft: rgba(255, 153, 164, .16);
	            --hover: rgba(255, 255, 255, .06);
	            --track: rgba(255, 255, 255, .12);
	            --inset: rgba(255, 255, 255, .05);
	            --shadow: 0 24px 64px rgba(0, 0, 0, .55), 0 2px 8px rgba(0, 0, 0, .3);
	          }
	          .card .chd { background: linear-gradient(180deg, rgba(255,255,255,.04), transparent); }
	          .mainbtn { box-shadow: none; }
	          .cline.INFO .tx { color: #6ccb5f; }
	          .cline.SKIP .tx { color: #7cb8ff; }
	          .cline.WARN .tx { color: #f0b45a; }
	          .cline.ERROR .tx { color: #ff99a4; }
	          .cline.OK .tx { color: #5fd4c4; }
	          .cline.LLM .tx { color: #c3a6ff; }
	          .cline.PICK .tx { color: #6fd3e0; }
	        }
	      </style>
	      <div class="panel" id="panel">
	        <button class="fab" id="fab" title="展开学习通任务助手" aria-label="展开面板">
	          <svg viewBox="0 0 16 16" aria-hidden="true">
	            <path d="M4.2 2.6 13 8l-8.8 5.4V2.6Z" fill="currentColor"/>
	          </svg>
	        </button>
	        <div class="shell" id="shell">
	          <button class="collapse" id="btnmin" title="收起面板" aria-label="收起面板">
	            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
	              <path d="M4 10.2 8 6.2l4 4" stroke="currentColor" stroke-width="1.5"
	                    stroke-linecap="round" stroke-linejoin="round"/>
	            </svg>
	          </button>
	          <div class="body" id="body">
	            <div class="col-left">
	              <div class="dock" id="dock">
	                <div class="dock-top">
	                  <span class="pill p-idle" id="vstatus"><i></i>未启动</span>
	                  <span class="curtask" id="vcur">—</span>
	                </div>
	                <div class="dock-actions">
	                  <button class="iconbtn" id="btnadv" title="高级设置" aria-label="高级设置">
	                    <svg viewBox="0 0 24 24" aria-hidden="true">
	                      <path fill="currentColor" d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
	                    </svg>
	                    <span class="dot warn" id="advdot"></span>
	                  </button>
	                  <button class="mainbtn start" id="btnstart">开始刷课</button>
	                </div>
	              </div>

	              <div class="sect"><span class="st">运行设置</span></div>
	              <div class="switches">
	                <label class="sw" title="视频静音播放（观看时长照常上报）">
	                  <span class="swlead">
	                    <svg viewBox="0 0 16 16" fill="none"><path d="M8.6 2.5 5.4 5.2H3.2a.7.7 0 0 0-.7.7v4.2c0 .4.3.7.7.7h2.2l3.2 2.7V2.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M11 6a2.6 2.6 0 0 1 0 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
	                  </span>
	                  <span class="swlabel">静音播放</span>
	                  <input type="checkbox" id="optmute"><span class="track"></span>
	                </label>
	                <label class="sw" title="自动探测课程允许的最高倍速；若站点不允许则回退 1x">
	                  <span class="swlead">
	                    <svg viewBox="0 0 16 16" fill="none"><path d="M3.2 4.6 7 8l-3.8 3.4V4.6Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M8.5 4.6 12.3 8l-3.8 3.4V4.6Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
	                  </span>
	                  <span class="swlabel">最高倍速</span>
	                  <input type="checkbox" id="optautorate"><span class="track"></span>
	                </label>
	                <label class="sw" title="调用多模态模型自动作答答题任务点">
	                  <span class="swlead">
	                    <svg viewBox="0 0 16 16" fill="none"><path d="M8 2.2l1 2.9 2.9 1-2.9 1-1 2.9-1-2.9-2.9-1 2.9-1 1-2.9Z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><path d="M12.4 9.5l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5.5-1.4Z" fill="currentColor"/></svg>
	                  </span>
	                  <span class="swlabel">自动答题</span>
	                  <input type="checkbox" id="optanswer"><span class="track"></span>
	                </label>
	                <label class="sw" title="作答完成后自动点击「暂时保存」">
	                  <span class="swlead">
	                    <svg viewBox="0 0 16 16" fill="none"><path d="M3.5 2.8h7.2l1.8 1.8v8.6H3.5V2.8Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5.6 2.8v3.1h4.3V2.8M5.6 13.2V9.6h4.8v3.6" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
	                  </span>
	                  <span class="swlabel">自动暂存</span>
	                  <input type="checkbox" id="opttempsave"><span class="track"></span>
	                </label>
	                <label class="sw" title="已有答案的题目不再作答">
	                  <span class="swlead">
	                    <svg viewBox="0 0 16 16" fill="none"><path d="M8 13.2A5.2 5.2 0 1 0 8 2.8a5.2 5.2 0 0 0 0 10.4Z" stroke="currentColor" stroke-width="1.2"/><path d="m5.8 8.1 1.6 1.6 2.9-3.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
	                  </span>
	                  <span class="swlabel">跳过已作答</span>
	                  <input type="checkbox" id="optskipfilled"><span class="track"></span>
	                </label>
	              </div>
	            </div>
	            <div class="col-right">
	              <div class="loghd">
	                <span class="st">运行日志</span>
	                <span class="lessonprog" id="vlesson" title="当前课时">—</span>
	              </div>
	              <div class="log" id="vlog"></div>
	            </div>
	          </div>
	          <div class="imgmask" id="imgmask" style="display:none">
	            <div class="box">
	              <div class="bh">
	                <span class="bt" id="imgtitle">题目图片</span>
	                <span class="bx" id="imgclose" title="关闭">×</span>
	              </div>
	              <div class="bb"><img id="imgfull" alt="题目图片"></div>
	            </div>
	          </div>
	        </div>
	      </div>`;

		function ensure() {
			if (host && host.isConnected) {
				refreshBadges();
				return;
			}
			host = document.createElement("div");
			host.id = "cxap-panel-host";
			host.style.cssText = "position:fixed;z-index:2147483000;top:70px;right:16px;";
			root = host.attachShadow({ mode: "open" });
			root.innerHTML = HTML;
			document.body.appendChild(host);
			S.panels.push(host);

			el = {
				panel: root.getElementById("panel"),
				shell: root.getElementById("shell"),
				fab: root.getElementById("fab"),
				dock: root.getElementById("dock"),
				status: root.getElementById("vstatus"),
				lesson: root.getElementById("vlesson"),
				cur: root.getElementById("vcur"),
				log: root.getElementById("vlog"),
				imgmask: root.getElementById("imgmask"),
				imgFull: root.getElementById("imgfull"),
				imgTitle: root.getElementById("imgtitle"),
				btnStart: root.getElementById("btnstart"),
				btnAdv: root.getElementById("btnadv"),
				advDot: root.getElementById("advdot"),
				optMute: root.getElementById("optmute"),
				optAutoRate: root.getElementById("optautorate"),
				optAnswer: root.getElementById("optanswer"),
				optTempSave: root.getElementById("opttempsave"),
				optSkipFilled: root.getElementById("optskipfilled"),
				btnMin: root.getElementById("btnmin"),
			};

			const ans = store.config("answer", ANSWER_DEFAULTS);
			const vid = store.config("video", VIDEO_DEFAULTS);
			el.optMute.checked = !!store.get("mute", false);
			el.optAutoRate.checked = vid.autoRate !== false;
			el.optAnswer.checked = !!ans.enabled;
			el.optTempSave.checked = !!ans.autoTempSave;
			el.optSkipFilled.checked = !!ans.skipFilled;

			el.optMute.addEventListener("change", () => store.set("mute", el.optMute.checked));
			el.optAutoRate.addEventListener("change", () => {
				patchVideo({ autoRate: el.optAutoRate.checked });
				Log.useSystem();
				Log.info(el.optAutoRate.checked ? "已开启自动最高倍速" : "已关闭自动倍速，按 1x 播放");
			});
			el.optAnswer.addEventListener("change", () => {
				patchAnswer({ enabled: el.optAnswer.checked });
				refreshBadges();
			});
			el.optTempSave.addEventListener("change", () =>
				patchAnswer({ autoTempSave: el.optTempSave.checked }),
			);
			el.optSkipFilled.addEventListener("change", () =>
				patchAnswer({ skipFilled: el.optSkipFilled.checked }),
			);

			el.btnStart.addEventListener("click", () => {
				if (S.running) Runner.stop();
				else Runner.start();
			});
			el.btnAdv.addEventListener("click", () => ConfigUI.open());
			// 图片弹窗关闭
			root.getElementById("imgclose").addEventListener("click", closeImage);
			el.imgmask.addEventListener("click", (e) => {
				if (e.target === el.imgmask) closeImage();
			});
			root.addEventListener("keydown", (e) => {
				if (e.key === "Escape") closeImage();
			});
			el.btnMin.addEventListener("click", () => setCollapsed(true));
			el.log.addEventListener(
				"scroll",
				() => {
					followLog = isNearBottom();
				},
				{ passive: true },
			);

			restorePosition();
			bindDrag();
			bindFab();
			refreshBadges();
		}

		/** 收起 / 展开：收起后面板变为圆形播放按钮 */
		let collapseAnim = 0;

		/** 收起 / 展开：收起时面板向收起按钮方向收缩为圆形播放按钮 */
		function setCollapsed(collapsed) {
			if (!el.panel) return;
			if (el.panel.classList.contains("collapsed") === collapsed) return;
			const token = ++collapseAnim;
			const reduce =
				typeof window.matchMedia === "function" &&
				window.matchMedia("(prefers-reduced-motion: reduce)").matches;
			const dur = 180;

			if (collapsed) {
				el.panel.classList.remove("expanding");
				const pr = el.panel.getBoundingClientRect();
				const br = el.btnMin.getBoundingClientRect();
				const size = 54;
				const targetLeft = clamp(
					br.left + br.width / 2 - size / 2,
					0,
					Math.max(0, window.innerWidth - size),
				);
				const targetTop = clamp(
					br.top + br.height / 2 - size / 2,
					0,
					Math.max(0, window.innerHeight - size),
				);
				host.style.right = "auto";
				host.style.left = pr.left + "px";
				host.style.top = pr.top + "px";
				if (reduce) {
					el.panel.classList.add("collapsed");
					el.fab.setAttribute("aria-expanded", "false");
					host.style.left = targetLeft + "px";
					host.style.top = targetTop + "px";
					return;
				}
				el.panel.classList.add("collapsing");
				el.panel.style.width = pr.width + "px";
				el.panel.style.height = pr.height + "px";
				el.panel.style.borderRadius = "8px";
				const start = { left: pr.left, top: pr.top, w: pr.width, h: pr.height };
				const t0 = performance.now();
				const step = (now) => {
					if (token !== collapseAnim) return;
					const p = Math.min(1, (now - t0) / dur);
					const e = 1 - Math.pow(1 - p, 3);
					host.style.left = start.left + (targetLeft - start.left) * e + "px";
					host.style.top = start.top + (targetTop - start.top) * e + "px";
					el.panel.style.width = start.w + (size - start.w) * e + "px";
					el.panel.style.height = start.h + (size - start.h) * e + "px";
					el.panel.style.borderRadius = 8 + (27 - 8) * e + "px";
					if (p < 1) {
						requestAnimationFrame(step);
						return;
					}
					el.panel.classList.remove("collapsing");
					el.panel.classList.add("collapsed");
					el.fab.setAttribute("aria-expanded", "false");
					el.panel.style.width = "";
					el.panel.style.height = "";
					el.panel.style.borderRadius = "";
					host.style.left = targetLeft + "px";
					host.style.top = targetTop + "px";
				};
				requestAnimationFrame(step);
				return;
			}

			// 展开：从圆形按钮位置恢复，右边缘与按钮右边缘对齐（向左下方展开）
			el.panel.classList.remove("collapsing");
			const fr = el.panel.getBoundingClientRect();
			el.panel.classList.add("expanding");
			el.panel.classList.remove("collapsed");
			el.fab.setAttribute("aria-expanded", "true");
			const full = el.panel.getBoundingClientRect();
			const targetLeft = clamp(
				fr.right - full.width,
				0,
				Math.max(0, window.innerWidth - full.width),
			);
			const targetTop = clamp(
				fr.top,
				0,
				Math.max(0, window.innerHeight - full.height),
			);
			host.style.right = "auto";
			if (reduce) {
				host.style.left = targetLeft + "px";
				host.style.top = targetTop + "px";
				el.panel.classList.remove("expanding");
				return;
			}
			host.style.left = fr.left + "px";
			host.style.top = fr.top + "px";
			el.panel.style.width = fr.width + "px";
			el.panel.style.height = fr.height + "px";
			el.panel.style.borderRadius = "27px";
			const start = { left: fr.left, top: fr.top, w: fr.width, h: fr.height };
			const t0 = performance.now();
			const step = (now) => {
				if (token !== collapseAnim) return;
				const p = Math.min(1, (now - t0) / dur);
				const e = 1 - Math.pow(1 - p, 3);
				host.style.left = start.left + (targetLeft - start.left) * e + "px";
				host.style.top = start.top + (targetTop - start.top) * e + "px";
				el.panel.style.width = start.w + (full.width - start.w) * e + "px";
				el.panel.style.height = start.h + (full.height - start.h) * e + "px";
				el.panel.style.borderRadius = 27 + (8 - 27) * e + "px";
				if (p < 1) {
					requestAnimationFrame(step);
					return;
				}
				el.panel.classList.remove("expanding");
				el.panel.style.width = "";
				el.panel.style.height = "";
				el.panel.style.borderRadius = "";
				host.style.left = targetLeft + "px";
				host.style.top = targetTop + "px";
			};
			requestAnimationFrame(step);
		}

		/** 圆形收起态支持拖动与点击展开 */
		function bindFab() {
			let down = null;
			el.fab.addEventListener("pointerdown", (e) => {
				if (!el.panel.classList.contains("collapsed")) return;
				const r = host.getBoundingClientRect();
				down = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
				host.style.right = "auto";
				try {
					el.fab.setPointerCapture(e.pointerId);
				} catch (err) {
					/* noop */
				}
			});
			el.fab.addEventListener("pointermove", (e) => {
				if (!down) return;
				const dx = e.clientX - down.sx,
					dy = e.clientY - down.sy;
				if (!down.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
				down.moved = true;
				const b = bounds();
				host.style.left = clamp(down.ox + dx, 0, b.maxX) + "px";
				host.style.top = clamp(down.oy + dy, 0, b.maxY) + "px";
			});
			const end = () => {
				if (!down) return;
				const moved = down.moved;
				down = null;
				if (moved) {
					const r = host.getBoundingClientRect();
					store.set("panelPos", { x: Math.round(r.left), y: Math.round(r.top) });
				} else {
					setCollapsed(false);
				}
			};
			el.fab.addEventListener("pointerup", end);
			el.fab.addEventListener("pointercancel", end);
		}

		/** 局部更新答题配置（避免覆盖其它字段） */
		function patchAnswer(patch) {
			const cur = store.config("answer", ANSWER_DEFAULTS);
			Object.keys(patch).forEach((k) => {
				cur[k] = patch[k];
			});
			store.set("answer", cur);
		}

		/** 局部更新视频配置 */
		function patchVideo(patch) {
			const cur = store.config("video", VIDEO_DEFAULTS);
			Object.keys(patch).forEach((k) => {
				cur[k] = patch[k];
			});
			store.set("video", cur);
		}

		function refreshBadges() {
			if (!el.advDot) return;
			const cfg = store.config("llm", LLM_DEFAULTS);
			const ok = !!(cfg.apiKey && cfg.baseUrl && cfg.model);
			el.advDot.className = "dot " + (ok ? "ok" : "warn");
			if (el.btnAdv)
				el.btnAdv.title = ok ? "高级设置 · 模型：" + cfg.model : "高级设置 · 模型未配置";
		}

		/** 面板可视边界（按实际尺寸裁剪，避免宽带面板被拖出屏幕外） */
		function bounds() {
			const r = host.getBoundingClientRect();
			return {
				maxX: Math.max(0, window.innerWidth - Math.max(120, r.width)),
				maxY: Math.max(0, window.innerHeight - Math.max(40, r.height)),
			};
		}

		function restorePosition() {
			const pos = store.get("panelPos", null);
			if (pos && typeof pos.x === "number" && typeof pos.y === "number") {
				const b = bounds();
				host.style.right = "auto";
				host.style.left = clamp(pos.x, 0, b.maxX) + "px";
				host.style.top = clamp(pos.y, 0, b.maxY) + "px";
			}
		}
		function clamp(v, a, b) {
			return Math.max(a, Math.min(b, v));
		}

		function bindDrag() {
			let drag = null;
			el.shell.addEventListener("pointerdown", (e) => {
				if (e.button !== 0) return;
				if (el.panel.classList.contains("collapsed")) return;
				if (el.imgmask && el.imgmask.style.display !== "none") return;
				const t = e.target;
				// 按钮 / 开关 / 缩略图 / 日志卡片 / 弹窗等区域不参与拖拽
				if (
					t.closest(
						"button, input, select, textarea, a, label, .thumb, .imgmask, .fab, .card",
					)
				)
					return;
				// 日志空白背景可拖拽，但滚动条区域留给原生滚动
				if (el.log && t.closest(".log")) {
					const lr = el.log.getBoundingClientRect();
					const sbw = el.log.offsetWidth - el.log.clientWidth;
					if (sbw > 0 && e.clientX >= lr.right - sbw) return;
				}
				const r = host.getBoundingClientRect();
				drag = {
					sx: e.clientX,
					sy: e.clientY,
					ox: r.left,
					oy: r.top,
					moved: false,
					id: e.pointerId,
				};
				host.style.right = "auto";
				try {
					el.shell.setPointerCapture(e.pointerId);
				} catch (err) {
					/* noop */
				}
				e.preventDefault();
			});
			el.shell.addEventListener("pointermove", (e) => {
				if (!drag || e.pointerId !== drag.id) return;
				const dx = e.clientX - drag.sx,
					dy = e.clientY - drag.sy;
				if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
				if (!drag.moved) {
					drag.moved = true;
					el.panel.classList.add("dragging");
				}
				e.preventDefault();
				const b = bounds();
				host.style.left = clamp(drag.ox + dx, 0, b.maxX) + "px";
				host.style.top = clamp(drag.oy + dy, 0, b.maxY) + "px";
			});
			const end = () => {
				if (!drag) return;
				const moved = drag.moved;
				drag = null;
				el.panel.classList.remove("dragging");
				if (moved) {
					const r = host.getBoundingClientRect();
					store.set("panelPos", { x: Math.round(r.left), y: Math.round(r.top) });
				}
			};
			el.shell.addEventListener("pointerup", end);
			el.shell.addEventListener("pointercancel", end);
		}

		// ============ 日志卡片流 ============
		// 每张卡片是一段独立的过程记录：系统信息 / 视频任务点 / 答题任务点 / 单道题目

		const cards = new Map(); // key → { node, body, badge, lines, kind }
		let followLog = true; // 用户停留在底部时自动跟随新日志

		/** 建卡或取卡 */
		function ensureCard(key, opts) {
			if (!el.log) return null;
			let c = cards.get(key);
			if (c && c.node.isConnected) return c;
			const o = opts || {};
			const node = document.createElement("div");
			node.className = "card " + (o.kind || "sys");
			const hd = document.createElement("div");
			hd.className = "chd";
			const bar = document.createElement("span");
			bar.className = "bar";
			const title = document.createElement("span");
			title.className = "ctitle";
			title.textContent = o.title || "记录";
			const badge = document.createElement("span");
			badge.className = "cbadge";
			badge.textContent = o.badge || "";
			badge.style.display = o.badge ? "" : "none";
			hd.appendChild(bar);
			hd.appendChild(title);
			hd.appendChild(badge);
			const body = document.createElement("div");
			body.className = "cbody";
			node.appendChild(hd);
			node.appendChild(body);
			el.log.appendChild(node);
			c = { node, body, badge, title, lines: 0, kind: o.kind || "sys" };
			cards.set(key, c);
			trimCards();
			return c;
		}

		/** 卡片标题/徽标更新 */
		function cardMeta(key, opts) {
			const c = ensureCard(key, opts);
			if (!c) return;
			if (opts && opts.kind) {
				c.node.className = "card " + opts.kind;
				c.kind = opts.kind;
			}
			if (opts && opts.title) c.title.textContent = opts.title;
			if (opts && opts.badge !== undefined) {
				c.badge.textContent = opts.badge;
				c.badge.style.display = opts.badge ? "" : "none";
				c.badge.className = "cbadge" + (opts.badgeCls ? " " + opts.badgeCls : "");
			}
		}

		/** 追加一行到卡片 */
		function cardLine(key, level, line) {
			const c = ensureCard(key);
			if (!c) return;
			const row = document.createElement("div");
			row.className = "cline " + level;
			const ts = document.createElement("span");
			ts.className = "ts";
			ts.textContent = new Date().toTimeString().slice(0, 5);
			const tx = document.createElement("span");
			tx.className = "tx";
			tx.textContent = line;
			row.appendChild(ts);
			row.appendChild(tx);
			c.body.appendChild(row);
			c.lines++;
			autoscroll();
		}

		/** 往卡片里插入题目缩略图（点击弹出查看） */
		function cardThumb(key, dataUrl, caption, tip) {
			const c = ensureCard(key);
			if (!c || !dataUrl) return;
			const wrap = document.createElement("div");
			wrap.className = "thumb";
			const img = document.createElement("img");
			img.src = dataUrl;
			const tt = document.createElement("span");
			tt.className = "tt";
			tt.textContent = caption || "查看发送给模型的题目图";
			const small = document.createElement("small");
			small.textContent = tip || "点击弹窗查看原图";
			tt.appendChild(small);
			wrap.appendChild(img);
			wrap.appendChild(tt);
			wrap.addEventListener("click", () => openImage(dataUrl, caption));
			// 缩略图插到卡片正文最前，保证「先图后答」的阅读顺序
			if (c.body.firstChild) c.body.insertBefore(wrap, c.body.firstChild);
			else c.body.appendChild(wrap);
			autoscroll();
		}

		/** 打开图片弹窗 */
		function openImage(dataUrl, title) {
			if (!el.imgmask || !dataUrl) return;
			el.imgFull.src = dataUrl;
			el.imgTitle.textContent = title || "题目图片";
			el.imgmask.style.display = "flex";
		}
		function closeImage() {
			if (!el.imgmask) return;
			el.imgmask.style.display = "none";
			el.imgFull.removeAttribute("src");
		}

		function trimCards() {
			while (cards.size > CFG.logMaxCards && el.log.firstChild) {
				const first = el.log.firstChild;
				// 按 DOM 顺序淘汰最早创建的卡片
				for (const [k, c] of cards) {
					if (c.node === first) {
						cards.delete(k);
						break;
					}
				}
				el.log.removeChild(first);
			}
		}

		function isNearBottom() {
			if (!el.log) return true;
			return el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight < 80;
		}

		function autoscroll() {
			// 用户向上翻阅历史日志时不强制拉回底部
			if (el.log && (followLog || isNearBottom())) el.log.scrollTop = el.log.scrollHeight;
		}

		/** 清空全部卡片（重新开始时调用） */
		function clearCards() {
			cards.clear();
			if (el.log) el.log.innerHTML = "";
			followLog = true;
		}

		const STATUS_CLS = {
			运行中: "p-run",
			等待中: "p-wait",
			异常: "p-err",
			已完成: "p-done",
			已停止: "p-idle",
			未启动: "p-idle",
		};

		return {
			ensure,
			refreshBadges,
			// 日志卡片流 API
			ensureCard,
			cardMeta,
			cardLine,
			cardThumb,
			clearCards,
			openImage,
			closeImage,
			setStatus(s) {
				S.status = s;
				// 主按钮在「开始 / 停止」间切换
				if (el.btnStart) {
					const running = s === "运行中" || s === "等待中";
					el.btnStart.textContent = running ? "停止" : "开始刷课";
					el.btnStart.className = "mainbtn " + (running ? "stop" : "start");
				}
				if (!el.status) return;
				const cls = STATUS_CLS[s] || "p-idle";
				if (el.dock) el.dock.dataset.state = cls;
				el.status.className = "pill " + cls;
				el.status.innerHTML = "<i></i>" + s;
			},
			setLesson(text) {
				if (el.lesson) el.lesson.textContent = text;
				if (el.lesson) el.lesson.title = text;
			},
			setTask(text) {
				S.taskLabel = text;
				if (el.cur) el.cur.textContent = text;
			},
		};
	})();

	// >>> 05-config-ui.js
	// ========================= 8. 配置对话框（仅模型接口 + 高级项） =========================

	const ConfigUI = (function () {
		let host = null,
			root = null,
			fields = {};

		const HTML = `
	    <style>
	      :host { all: initial; color-scheme: light dark; }
	      * { box-sizing: border-box; margin: 0; padding: 0;
	          font-family: "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI",
	                       "Microsoft YaHei", "PingFang SC", sans-serif; }
	      .mask { position: fixed; inset: 0; display: flex; align-items: center;
	              justify-content: center; z-index: 2147483600;
	              background: rgba(20, 20, 20, .45);
	              backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
	      .dlg { --accent: #0067c0; --accent-hover: #1975c5; --accent-text: #fff;
	             --stroke: rgba(0,0,0,.09); --stroke-strong: rgba(0,0,0,.16);
	             --text: #1b1b1b; --text-2: #5c5c5c; --text-3: #8b8b8b;
	             --field: rgba(255,255,255,.72); --card: rgba(255,255,255,.55);
	             --inset: rgba(255,255,255,.60); --hover: rgba(0,0,0,.035);
	             width: min(620px, calc(100vw - 32px)); max-height: 88vh; overflow: auto;
	             background: rgba(243,243,243,.94);
	             backdrop-filter: blur(40px) saturate(1.5);
	             -webkit-backdrop-filter: blur(40px) saturate(1.5);
	             border: 1px solid var(--stroke); border-radius: 8px;
	             box-shadow: 0 28px 72px rgba(0,0,0,.34), 0 2px 8px rgba(0,0,0,.16);
	             font-size: 12.5px; color: var(--text); }
	      .hd { position: sticky; top: 0; z-index: 2; display: flex; align-items: center;
	            justify-content: space-between; height: 48px; padding: 0 10px 0 18px;
	            border-bottom: 1px solid var(--stroke);
	            background: rgba(243,243,243,.97);
	            backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }
	      .hd h3 { font-family: "Segoe UI Variable Display", "Segoe UI",
	               "Microsoft YaHei UI", sans-serif; font-size: 14px; font-weight: 600;
	               letter-spacing: .1px; }
	      .hd .x { width: 36px; height: 30px; border-radius: 4px; cursor: pointer;
	               display: flex; align-items: center; justify-content: center;
	               color: var(--text-2); font-size: 17px; transition: background .12s, color .12s; }
	      .hd .x:hover { background: rgba(196,43,28,.12); color: #c42b1c; }
	      .bd { padding: 2px 18px 14px; }
	      .sec { display: flex; align-items: center; gap: 8px; margin: 18px 0 8px;
	             font-size: 12px; font-weight: 600; color: var(--text); }
	      .sec::before { content: ""; width: 3px; height: 12px; border-radius: 2px;
	                     background: var(--accent); }
	      .group { background: var(--card); border: 1px solid var(--stroke);
	               border-radius: 8px; overflow: hidden;
	               box-shadow: inset 0 1px 0 var(--inset); }
	      .row { display: flex; align-items: center; gap: 14px;
	             min-height: 50px; padding: 8px 14px; }
	      .row + .row { border-top: 1px solid var(--stroke); }
	      .row:hover { background: var(--hover); }
	      .row .rl { flex: 0 0 128px; color: var(--text); font-size: 12.5px; }
	      .row .ctl { flex: 1 1 auto; min-width: 0; }
	      .row .ctl.narrow { flex: 0 1 300px; margin-left: auto; }
	      .row .ctl.tiny { flex: 0 1 120px; margin-left: auto; }
	      .row.col { flex-direction: column; align-items: stretch; gap: 6px; }
	      .row.col .rl { flex: none; }
	      .row .chips { flex: 0 1 auto; margin-left: auto; justify-content: flex-end; }
	      .chkctl { margin-left: auto; width: 18px; height: 18px; flex: 0 0 auto;
	                accent-color: var(--accent); cursor: pointer; }
	      input[type=text], input[type=password], input[type=number], select, textarea {
	        width: 100%; height: 32px; padding: 0 10px; border: 1px solid var(--stroke-strong);
	        border-radius: 4px; background: var(--field); color: var(--text);
	        font-family: inherit; font-size: 12px; outline: none;
	        transition: border-color .12s, background .12s, box-shadow .12s; }
	      textarea { height: auto; min-height: 64px; padding: 7px 10px; resize: vertical;
	                 font-family: "Cascadia Mono", Consolas, monospace; }
	      input:hover, select:hover, textarea:hover { border-color: rgba(0,0,0,.28); }
	      input:focus, select:focus, textarea:focus { background: #fff;
	        border-color: var(--accent); box-shadow: inset 0 -2px 0 var(--accent); }
	      .chips { display: flex; flex-wrap: wrap; gap: 6px; }
	      .chip { display: inline-flex; align-items: center; height: 28px; padding: 0 12px;
	              border: 1px solid var(--stroke-strong); border-radius: 999px;
	              background: transparent; color: var(--text-2); font-size: 12px;
	              font-weight: 500; cursor: pointer; user-select: none;
	              transition: background .12s, color .12s, border-color .12s; }
	      .chip:hover { background: rgba(0,0,0,.045); color: var(--text); }
	      .chip.on { background: var(--accent); border-color: var(--accent);
	                 color: var(--accent-text); }
	      .chip.on:hover { background: var(--accent-hover); }
	      .chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
	      .ft { position: sticky; bottom: 0; display: flex; align-items: center; gap: 8px;
	            padding: 12px 18px 14px; border-top: 1px solid var(--stroke);
	            background: rgba(243,243,243,.96); }
	      .ft .grow { flex: 1; }
	      button { height: 32px; padding: 0 16px; border: 1px solid transparent;
	               border-radius: 4px; cursor: pointer; font-family: inherit;
	               font-size: 12px; font-weight: 600;
	               transition: background .12s, border-color .12s, color .12s; }
	      button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
	      .primary { background: var(--accent); color: var(--accent-text); }
	      .primary:hover { background: var(--accent-hover); }
	      .ghost { background: rgba(255,255,255,.55); color: var(--text);
	               border-color: var(--stroke-strong); }
	      .ghost:hover { background: rgba(255,255,255,.9); }
	      .test { background: rgba(15,123,15,.10); color: #0f7b0f; }
	      .test:hover { background: rgba(15,123,15,.16); }
	      button:disabled { opacity: .5; cursor: not-allowed; }
	      .status { max-width: 250px; overflow: hidden; text-overflow: ellipsis;
	                white-space: nowrap; font-size: 11px; color: var(--text-2); }
	      .status.ok { color: #0f7b0f; }
	      .status.err { color: #c42b1c; }
	      .status.warn { color: #9d5d00; }
	      .dlg::-webkit-scrollbar { width: 10px; }
	      .dlg::-webkit-scrollbar-track { background: transparent; }
	      .dlg::-webkit-scrollbar-thumb { background: rgba(0,0,0,.16); border-radius: 5px;
	                                      border: 3px solid transparent;
	                                      background-clip: content-box; }
	      .dlg::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,.28);
	                                            background-clip: content-box; }
	      @media (max-width: 520px) {
	        .row { flex-wrap: wrap; }
	        .row .rl { flex: 1 1 100%; }
	        .row .ctl, .row .ctl.narrow, .row .ctl.tiny { flex: 1 1 100%; margin-left: 0; }
	        .row .chips { margin-left: 0; justify-content: flex-start; }
	        .chkctl { margin-left: 0; }
	      }

	      @media (prefers-color-scheme: dark) {
	        .dlg { --accent: #60cdff; --accent-hover: #7fd8ff; --accent-text: #003a4d;
	               --stroke: rgba(255,255,255,.09); --stroke-strong: rgba(255,255,255,.20);
	               --text: #f3f3f3; --text-2: #c7c7c7; --text-3: #9a9a9a;
	               --field: rgba(255,255,255,.06); --card: rgba(255,255,255,.055);
	               --inset: rgba(255,255,255,.05); --hover: rgba(255,255,255,.055);
	               background: rgba(32,32,32,.94);
	               box-shadow: 0 28px 72px rgba(0,0,0,.6), 0 2px 8px rgba(0,0,0,.35); }
	        .hd { background: rgba(32,32,32,.97); }
	        .hd .x:hover { background: rgba(255,153,164,.16); color: #ff99a4; }
	        input:focus, select:focus, textarea:focus { background: rgba(255,255,255,.10); }
	        input:hover, select:hover, textarea:hover { border-color: rgba(255,255,255,.32); }
	        .ghost { background: rgba(255,255,255,.06); }
	        .ghost:hover { background: rgba(255,255,255,.10); }
	        .test { background: rgba(108,203,95,.14); color: #6ccb5f; }
	        .test:hover { background: rgba(108,203,95,.20); }
	        .chip:hover { background: rgba(255,255,255,.08); }
	        .ft { background: rgba(32,32,32,.96); }
	        .dlg::-webkit-scrollbar-thumb { background: rgba(255,255,255,.18);
	                                        background-clip: content-box; }
	        .dlg::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,.30);
	                                              background-clip: content-box; }
	        .status.ok { color: #6ccb5f; }
	        .status.err { color: #ff99a4; }
	        .status.warn { color: #f0b45a; }
	      }
	    </style>
	    <div class="mask">
	      <div class="dlg">
	        <div class="hd">
	          <span class="ttl"><h3>高级设置</h3></span>
	          <span class="x" id="close">×</span>
	        </div>
	        <div class="bd">
	          <div class="sec">作答设置</div>
	          <div class="group">
	            <div class="row">
	              <span class="rl">作答题型</span>
	              <div class="chips" id="types">
	                <span class="chip on" data-type="单选" role="button" tabindex="0">单选题</span>
	                <span class="chip on" data-type="多选" role="button" tabindex="0">多选题</span>
	                <span class="chip on" data-type="判断" role="button" tabindex="0">判断题</span>
	              </div>
	            </div>
	            <div class="row">
	              <label class="rl" for="unknownAction">无答案时</label>
	              <select class="ctl narrow" id="unknownAction">
	                <option value="skip">留空不作答（默认）</option>
	                <option value="guess">随机选一个（避免空题）</option>
	              </select>
	            </div>
	          </div>

	          <div class="sec">大模型设置</div>
	          <div class="group">
	            <div class="row">
	              <label class="rl" for="baseUrl">Base URL</label>
	              <input class="ctl" type="text" id="baseUrl" placeholder="https://api.openai.com/v1">
	            </div>
	            <div class="row">
	              <label class="rl" for="apiKey">API Key</label>
	              <input class="ctl" type="password" id="apiKey" placeholder="sk-...">
	            </div>
	            <div class="row">
	              <label class="rl" for="model">模型</label>
	              <input class="ctl" type="text" id="model" placeholder="gpt-4o / qwen-vl-max / glm-4v ...">
	            </div>
	            <div class="row">
	              <label class="rl" for="apiStyle">接口风格</label>
	              <select class="ctl narrow" id="apiStyle">
	                <option value="chat">Chat Completions（/chat/completions）</option>
	                <option value="responses">Responses API（/responses）</option>
	              </select>
	            </div>
	            <div class="row">
	              <label class="rl" for="temperature">Temperature</label>
	              <input class="ctl tiny" type="number" id="temperature" step="0.1" min="0" max="2">
	            </div>
	            <div class="row">
	              <label class="rl" for="maxTokens">Max tokens</label>
	              <input class="ctl tiny" type="number" id="maxTokens" step="128" min="64">
	            </div>
	            <div class="row col">
	              <label class="rl" for="extraHeaders">额外请求头</label>
	              <textarea class="ctl" id="extraHeaders" placeholder='{"X-Foo":"bar"}'></textarea>
	            </div>
	          </div>

	          <div class="sec">调试</div>
	          <div class="group">
	            <label class="row">
	              <span class="rl">输出请求与响应原文</span>
	              <input class="chkctl" type="checkbox" id="debugDump">
	            </label>
	          </div>
	        </div>
	        <div class="ft">
	          <button class="test" id="test">测试连通性</button>
	          <span class="status" id="status"></span>
	          <span class="grow"></span>
	          <button class="ghost" id="cancel">取消</button>
	          <button class="primary" id="save">保存</button>
	        </div>
	      </div>
	    </div>`;

		function ensure() {
			if (host && host.isConnected) return;
			host = document.createElement("div");
			host.id = "cxap-config-host";
			host.style.cssText = "position:fixed;inset:0;z-index:2147483600;";
			root = host.attachShadow({ mode: "open" });
			root.innerHTML = HTML;
			document.body.appendChild(host);
			S.panels.push(host);

			fields = {
				baseUrl: root.getElementById("baseUrl"),
				apiKey: root.getElementById("apiKey"),
				model: root.getElementById("model"),
				apiStyle: root.getElementById("apiStyle"),
				temperature: root.getElementById("temperature"),
				maxTokens: root.getElementById("maxTokens"),
				extraHeaders: root.getElementById("extraHeaders"),
				unknownAction: root.getElementById("unknownAction"),
				debugDump: root.getElementById("debugDump"),
				types: root.getElementById("types"),
				status: root.getElementById("status"),
			};

			root.getElementById("close").addEventListener("click", close);
			root.getElementById("cancel").addEventListener("click", close);
			root.getElementById("save").addEventListener("click", save);
			root.getElementById("test").addEventListener("click", testConnection);

			Array.from(fields.types.querySelectorAll(".chip")).forEach((chip) => {
				const toggle = () => {
					if (chip.classList.contains("on")) {
						// 至少保留一种题型
						const on = fields.types.querySelectorAll(".chip.on");
						if (on.length <= 1) return;
						chip.classList.remove("on");
					} else {
						chip.classList.add("on");
					}
				};
				chip.addEventListener("click", toggle);
				chip.addEventListener("keydown", (e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						toggle();
					}
				});
			});
		}

		function syncChips(types) {
			const map = types && typeof types === "object" ? types : ANSWER_DEFAULTS.types;
			Array.from(fields.types.querySelectorAll(".chip")).forEach((chip) => {
				chip.classList.toggle("on", map[chip.dataset.type] !== false);
			});
		}

		function readTypes() {
			const types = {};
			Array.from(fields.types.querySelectorAll(".chip")).forEach((chip) => {
				types[chip.dataset.type] = chip.classList.contains("on");
			});
			return types;
		}

		function fill(cfg, ans) {
			fields.baseUrl.value = cfg.baseUrl || "";
			fields.apiKey.value = cfg.apiKey || "";
			fields.model.value = cfg.model || "";
			fields.apiStyle.value = cfg.apiStyle || "chat";
			fields.temperature.value = String(cfg.temperature);
			fields.maxTokens.value = String(cfg.maxTokens);
			fields.extraHeaders.value = cfg.extraHeaders || "";
			fields.unknownAction.value = ans.unknownAction || "skip";
			fields.debugDump.checked = !!ans.debugDump;
			syncChips(ans.types);
			setStatus("", "");
		}

		function setStatus(text, cls) {
			if (!fields.status) return;
			fields.status.textContent = text;
			fields.status.title = text;
			fields.status.className = "status " + (cls || "");
		}

		function read() {
			const cfg = {
				baseUrl: fields.baseUrl.value.trim().replace(/\/+$/, ""),
				apiKey: fields.apiKey.value.trim(),
				model: fields.model.value.trim(),
				apiStyle: fields.apiStyle.value,
				temperature: parseFloat(fields.temperature.value) || 0,
				maxTokens: parseInt(fields.maxTokens.value, 10) || 2048,
				jsonMode: true,
				extraHeaders: fields.extraHeaders.value.trim(),
			};
			const ans = {
				unknownAction: fields.unknownAction.value,
				debugDump: fields.debugDump.checked,
				types: readTypes(),
			};
			return { cfg, ans };
		}

		function validate(cfg) {
			if (!cfg.baseUrl) return "请填写 Base URL";
			if (!/^https?:\/\//i.test(cfg.baseUrl)) return "Base URL 必须以 http(s):// 开头";
			if (!cfg.apiKey) return "请填写 API Key";
			if (!cfg.model) return "请填写模型名";
			return null;
		}

		function save() {
			const { cfg, ans } = read();
			const err = validate(cfg);
			if (err) {
				setStatus(err, "err");
				return false;
			}
			store.set("llm", cfg);
			// 只覆盖本弹窗负责的字段，其余（自动暂存 / 跳过已作答等）保留面板上的设置
			const merged = store.config("answer", ANSWER_DEFAULTS);
			merged.unknownAction = ans.unknownAction;
			merged.debugDump = ans.debugDump;
			merged.types = ans.types;
			store.set("answer", merged);
			Panel.refreshBadges();
			setStatus("已保存", "ok");
			setTimeout(close, 420);
			return true;
		}

		async function testConnection() {
			const { cfg } = read();
			const err = validate(cfg);
			if (err) return setStatus(err, "err");
			const btn = root.getElementById("test");
			btn.disabled = true;
			setStatus("请求中…", "");
			try {
				const res = await LLM.chat({
					config: cfg,
					messages: [
						{ role: "user", content: [{ type: "text", text: "ping，只回复 pong" }] },
					],
					timeout: 60000,
					// 连通性测试不需要 JSON 输出（提示词不含 "json" 会被接口拒绝），
					// 同时给足输出预算：推理模型的思考 token 也算在里面
					jsonMode: false,
					maxTokens: 512,
				});
				const txt = String(res.text || "").trim();
				if (txt) {
					setStatus("连通成功：" + txt.slice(0, 40), "ok");
					return;
				}
				// HTTP 通了但没有可见文字：多为输出预算被推理过程占用（status=incomplete）
				const raw = res.raw || {};
				const incomplete =
					raw.status === "incomplete" &&
					raw.incomplete_details &&
					raw.incomplete_details.reason === "length";
				setStatus(
					incomplete
						? "连通成功，但输出被截断（思考占用了 max tokens，可调大「max tokens」）"
						: "连通成功，但模型未返回文字",
					"warn",
				);
			} catch (e) {
				setStatus("失败：" + ((e && e.message) || e), "err");
			} finally {
				btn.disabled = false;
			}
		}

		function open() {
			ensure();
			fill(store.config("llm", LLM_DEFAULTS), store.config("answer", ANSWER_DEFAULTS));
			const dlg = root.querySelector(".dlg");
			if (dlg) dlg.scrollTop = 0;
			host.style.display = "";
		}

		function close() {
			if (host) host.style.display = "none";
		}

		return { open, close, save };
	})();

	// >>> 10-scanner.js
	// ========================= 9. 课程访问层（扫描 / 导航） =========================

	function courseParams() {
		const q = new URLSearchParams(location.search);
		return {
			courseId: q.get("courseId") || String(window.courseId || ""),
			clazzid: q.get("clazzid") || q.get("clazzId") || "",
			cpi: q.get("cpi") || "",
			chapterId: q.get("chapterId") || String(window.chapterId || ""),
		};
	}

	/** 扫描目录：按页面实际 DOM 顺序返回课时列表 */
	function scanLessons() {
		const rows = Dom.toArray(document.querySelectorAll(SEL.catalogLessonRow)).filter(
			(r) => r.querySelector(SEL.lessonName),
		); // 排除章节头（章节头只有 .posCatalog_title）
		return rows
			.map((row) => {
				const nameEl = row.querySelector(SEL.lessonName);
				const unfinishedEl = row.querySelector(SEL.lessonUnfinished);
				return {
					kid: (row.id || "").replace(/^cur/, ""),
					title: nameEl.getAttribute("title") || Dom.normText(nameEl.textContent),
					unfinished: unfinishedEl ? parseInt(unfinishedEl.value, 10) : -1,
					isCurrent: row.classList.contains(SEL.currentLessonActive),
				};
			})
			.filter((l) => l.kid);
	}

	function cardsIframeEl() {
		return document.querySelector(SEL.mainIframe);
	}

	/**
	 * 等待卡片 iframe 就绪（指定课时 + 卡片序号 0 起）。
	 * expectNew=true 时要求 iframe 装载了「新文档」——切换前先 tagCardsWindowForReload()
	 * 给旧窗口打标，避免 src 已变但 contentDocument 仍是上一张卡片内容的竞态（实测踩坑）。
	 */
	function tagCardsWindowForReload() {
		const f = cardsIframeEl();
		try {
			if (f && f.contentWindow) f.contentWindow.__cxapOldWindow = true;
		} catch (e) {
			/* noop */
		}
	}

	async function waitForCardsReady(kid, num0, timeout, expectNew) {
		return waitFor(
			() => {
				const f = cardsIframeEl();
				if (!f) return null;
				const src = f.src || "";
				if (src.indexOf("knowledgeid=" + kid) === -1) return null;
				if (num0 !== null && num0 !== undefined && src.indexOf("num=" + num0) === -1)
					return null;
				try {
					const w = f.contentWindow;
					if (!w || !w.document) return null;
					if (expectNew && w.__cxapOldWindow) return null; // 仍是切换前的旧文档
					const d = w.document;
					if (d.readyState !== "complete" || !d.body || d.body.children.length === 0)
						return null;
					return d;
				} catch (e) {
					return null;
				}
			},
			{ timeout: timeout || CFG.cardLoadTimeout, interval: 400, desc: "卡片内容加载" },
		);
	}

	/** 课程卡片 iframe 的地址（软导航兜底使用） */
	function cardsUrl(kid, num0) {
		const p = courseParams();
		return (
			"/mooc-ans/knowledge/cards?clazzid=" +
			encodeURIComponent(p.clazzid) +
			"&courseid=" +
			encodeURIComponent(p.courseId) +
			"&knowledgeid=" +
			encodeURIComponent(kid) +
			"&num=" +
			Math.max(0, num0 || 0) +
			"&ut=s&cpi=" +
			encodeURIComponent(p.cpi) +
			"&mooc2=1&isMicroCourse=false&editorPreview=0"
		);
	}

	// 导航方式一次选定后复用：避免每个课时都重复尝试 / 回退并刷屏
	let NAV_MODE = ""; // "" | "ajax" | "soft" | "iframe"
	const NAV_MODE_LABEL = {
		ajax: "站点内置 AJAX 导航",
		soft: "内容区软导航（studentstudyAjax）",
		iframe: "内容 iframe 直切",
	};

	function resetNavMode() {
		NAV_MODE = "";
	}

	function setNavMode(mode) {
		if (NAV_MODE === mode) return;
		const changed = !!NAV_MODE;
		NAV_MODE = mode;
		Log.useSystem();
		Log.info(
			(changed ? "课时切换方式变更：" : "课时切换方式：") +
				NAV_MODE_LABEL[mode] +
				"（页面不刷新）",
		);
	}

	/** 递归暂停课程内容里的所有视频（含嵌套 iframe），避免切课后后台继续播放 */
	function pauseCourseVideos(doc, depth) {
		const d = doc || Dom.docOf(cardsIframeEl());
		if (!d || (depth || 0) > 3) return;
		Dom.toArray(d.querySelectorAll("video")).forEach((v) => {
			try {
				v.pause();
			} catch (e) {
				/* noop */
			}
		});
		Dom.toArray(d.querySelectorAll("iframe")).forEach((f) => {
			const inner = Dom.docOf(f);
			if (inner) pauseCourseVideos(inner, (depth || 0) + 1);
		});
	}

	/** 不刷新页面的课时切换：直接换卡片 iframe，并同步目录高亮/地址栏 */
	function softActivateLesson(lesson) {
		Dom.toArray(document.querySelectorAll("." + SEL.currentLessonActive)).forEach((el) =>
			el.classList.remove(SEL.currentLessonActive),
		);
		const row =
			document.getElementById("cur" + lesson.kid) || document.getElementById(lesson.kid);
		if (row) row.classList.add(SEL.currentLessonActive);

		["chapterId", "chapterIdid", "curChapterId"].forEach((id) => {
			const el = document.getElementById(id);
			if (el) el.value = lesson.kid;
		});
		try {
			if (typeof window.chapterId !== "function") window.chapterId = lesson.kid;
			if (typeof window.ai_stu_knowledgeId !== "function")
				window.ai_stu_knowledgeId = lesson.kid;
		} catch (e) {
			/* noop */
		}
		try {
			if (typeof window.updateLastStudyKnowledge === "function")
				window.updateLastStudyKnowledge(lesson.kid);
		} catch (e) {
			/* noop */
		}
		try {
			const u = new URL(location.href);
			u.searchParams.set("chapterId", lesson.kid);
			history.replaceState(history.state, "", u.toString());
		} catch (e) {
			/* noop */
		}
	}

	/** 拉取 studentstudyAjax 返回的内容区 HTML（不依赖页面全局 jQuery） */
	async function fetchStudyHtml(lesson) {
		const p = courseParams();
		const apiBase =
			typeof window._HOST_CP2_ === "string" && window._HOST_CP2_ ? window._HOST_CP2_ : "";
		const params = new URLSearchParams({
			courseId: p.courseId,
			clazzid: p.clazzid,
			chapterId: lesson.kid,
			cpi: p.cpi,
			verificationcode: "",
			mooc2: "1",
			toComputer: "false",
			microTopicId: "0",
			editorPreview: "0",
			isPreviewVideo: "false",
			videoWidth: "0",
			videoHeight: "0",
			targetVideoJobId: "",
			cardIndex: "0",
		});
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), 15000);
		try {
			const res = await fetch(apiBase + "/mycourse/studentstudyAjax?" + params.toString(), {
				credentials: "same-origin",
				signal: ctrl.signal,
			});
			if (!res.ok) throw new Error("HTTP " + res.status);
			return await res.text();
		} finally {
			clearTimeout(timer);
		}
	}

	/** 用接口返回的 HTML 同步顶部卡片标签（多卡片课时不会因直切而漏处理） */
	function syncCardTabsFromHtml(html) {
		try {
			const doc = new DOMParser().parseFromString(html, "text/html");
			const src = doc.querySelector("#prev_tab");
			const dst = document.querySelector("#prev_tab");
			if (src && dst) dst.innerHTML = src.innerHTML;
			return doc;
		} catch (e) {
			return null;
		}
	}

	/** 直接切换卡片 iframe（不依赖站点脚本，页面不刷新） */
	async function directNavigateLesson(lesson) {
		const f = cardsIframeEl();
		if (!f) throw new Error("未找到课程内容 iframe");
		tagCardsWindowForReload();
		f.src = cardsUrl(lesson.kid, 0);
		softActivateLesson(lesson);
		await waitForCardsReady(lesson.kid, 0, undefined, true);
	}

	/**
	 * 软导航：
	 *  1. 优先复用站点的 studentstudyAjax 接口，把返回内容填回 #mainid
	 *     （与 getTeacherAjax 同源同行为，但不依赖页面全局函数，且不会整页跳转；
	 *      同时能刷新顶部卡片标签，避免多卡片课时被漏处理）
	 *  2. 接口不可用时才直接改 #iframe 的 src，仍然不刷新整页
	 */
	async function softNavigateLesson(lesson) {
		let html = null;
		try {
			html = await fetchStudyHtml(lesson);
		} catch (e) {
			/* 接口不可用：直接走 iframe 直切 */
		}
		const parsed = html ? syncCardTabsFromHtml(html) : null;
		const newMain = parsed ? parsed.getElementById("mainid") : null;
		const oldMain = document.getElementById("mainid");
		const $ = window.jQuery;

		if (newMain && oldMain && $ && typeof $.fn === "object") {
			tagCardsWindowForReload();
			try {
				$(oldMain).html(newMain.innerHTML);
			} catch (e) {
				/* 注入失败则走直切 */
			}
			const f = cardsIframeEl();
			if (f && (f.src || "").indexOf("knowledgeid=" + lesson.kid) !== -1) {
				softActivateLesson(lesson);
				await waitForCardsReady(lesson.kid, 0, undefined, true);
				setNavMode("soft");
				return;
			}
		}

		await directNavigateLesson(lesson);
		setNavMode("iframe");
	}

	/** 切换到指定课时：AJAX 导航优先，软导航 / iframe 兜底；任何情况下都不整页刷新 */
	async function gotoLesson(lesson) {
		pauseCourseVideos();
		// 已确定可用的方式直接复用，避免每课都重复失败尝试
		if (NAV_MODE === "soft") {
			await softNavigateLesson(lesson);
			return;
		}
		if (NAV_MODE === "iframe") {
			await directNavigateLesson(lesson);
			return;
		}

		const p = courseParams();
		const fn = window.getTeacherAjax;
		if (typeof fn === "function") {
			tagCardsWindowForReload();
			try {
				fn(p.courseId, p.clazzid, lesson.kid, p.cpi);
				await waitFor(
					() => {
						const active = document.querySelector("." + SEL.currentLessonActive);
						const f = cardsIframeEl();
						const activeOk = active && active.id === "cur" + lesson.kid;
						const iframeOk = f && (f.src || "").indexOf("knowledgeid=" + lesson.kid) !== -1;
						return activeOk || iframeOk ? true : null;
					},
					{ timeout: CFG.navTimeout, interval: 500, desc: "课时切换生效" },
				);
				await waitForCardsReady(lesson.kid, 0, undefined, true);
				setNavMode("ajax");
				return;
			} catch (e) {
				if (e === STOP) throw e;
				Log.warn("站点 AJAX 切课未生效，改用软导航");
			}
		}
		await softNavigateLesson(lesson);
	}

	/** 切换课时内卡片（changeDisplayContent 为主，直改 iframe src 兜底；不刷新整页） */
	async function switchCard(n, total, lesson) {
		pauseCourseVideos();
		const p = courseParams();
		tagCardsWindowForReload();
		const fn = window.changeDisplayContent;
		if (NAV_MODE !== "iframe" && typeof fn === "function") {
			Log.info("切换到卡片 " + n + " / " + total);
			fn(n, total, lesson.kid, p.courseId, p.clazzid, "");
		} else {
			const f = cardsIframeEl();
			if (!f) throw new Error("未找到课程内容 iframe");
			f.src = cardsUrl(lesson.kid, n - 1);
			Dom.toArray(document.querySelectorAll(SEL.cardTabs)).forEach((li) => {
				li.classList.remove("active");
				if (li.id === "dct" + n) li.classList.add("active");
			});
			try {
				if (typeof window.setChapterNumData === "function") window.setChapterNumData(n);
			} catch (e) {
				/* noop */
			}
		}
		await waitForCardsReady(lesson.kid, n - 1, undefined, true);
	}

	/** 读取卡片内卡片标签总数 */
	function cardTabCount(doc) {
		return doc ? doc.querySelectorAll(SEL.cardTabs).length : 0;
	}

	/** 扫描当前卡片内所有任务点 */
	function scanCardJobs(doc) {
		const jobs = [];
		Dom.toArray(doc.querySelectorAll(SEL.jobIcon)).forEach((icon) => {
			const attach = icon.closest(SEL.jobAttach) || icon.parentElement;
			const ifr = attach ? attach.querySelector("iframe") : null;
			const src = ifr ? ifr.getAttribute("src") || "" : "";
			let type = "other";
			if (icon.classList.contains("ans-job-video") || src.indexOf(URL_VIDEO_MODULE) !== -1)
				type = "video";
			else if (RE_ANSWER_MODULE.test(src)) type = "answer";

			let jobid = ifr ? ifr.getAttribute("jobid") || ifr.getAttribute("_jobid") : null;
			let jobData = null;
			if (ifr && ifr.getAttribute("data")) {
				jobData = safeParse(ifr.getAttribute("data"), null);
				if (!jobid && jobData && jobData.jobid) jobid = String(jobData.jobid);
			}
			jobs.push({
				type,
				jobid: jobid || "",
				title: jobTitle(attach, src, jobData),
				icon,
				iframe: ifr,
				data: jobData,
				done: isIconDone(icon),
			});
		});
		return jobs;
	}

	function jobTitle(attach, src, jobData) {
		if (jobData && (jobData.name || jobData.title))
			return String(jobData.name || jobData.title);
		if (attach) {
			const ifr = attach.querySelector("iframe");
			if (ifr && ifr.getAttribute("data")) {
				const d = safeParse(ifr.getAttribute("data"), null);
				if (d && (d.name || d.title)) return String(d.name || d.title);
			}
		}
		const m = String(src || "").match(/modules\/([a-z]+)\//);
		return m ? m[1] : "任务点";
	}

	function isIconDone(icon) {
		return (
			!icon ||
			(icon.getAttribute("aria-label") || "").indexOf(ICON_DONE_KEYWORD) !== -1
		);
	}

	/** 监听任务点图标 aria-label 翻转（事件驱动） */
	function watchIconDone(icon, onDone) {
		try {
			const obs = new MutationObserver(() => {
				if (isIconDone(icon)) onDone();
			});
			obs.observe(icon, { attributes: true, attributeFilter: ["aria-label", "class"] });
			S.observers.push(obs);
			return obs;
		} catch (e) {
			return null;
		}
	}

	// >>> 20-video.js
	// ========================= 10. 视频任务点处理 =========================

	/**
	 * 在视频 iframe 的 window 上挂钩 XMLHttpRequest，捕获进度上报响应中的 isPassed。
	 * 注意：只挂钩一次，后续调用仅更新回调。
	 */
	function installReportHook(vdoc, onPassed) {
		try {
			const win = vdoc.defaultView;
			if (!win || !win.XMLHttpRequest) return;
			if (!win.__cxapHooked) {
				win.__cxapHooked = true;
				const proto = win.XMLHttpRequest.prototype;
				const oOpen = proto.open,
					oSend = proto.send;
				proto.open = function (method, url) {
					try {
						this.__cxapUrl = String(url || "");
					} catch (e) {
						/* noop */
					}
					return oOpen.apply(this, arguments);
				};
				proto.send = function () {
					const xhr = this;
					if (xhr.__cxapUrl && xhr.__cxapUrl.indexOf(REPORT_URL_KEYWORD) !== -1) {
						xhr.addEventListener("load", function () {
							try {
								const body = String(xhr.responseText || "");
								let passed = false;
								try {
									passed = JSON.parse(body).isPassed === true;
								} catch (e) {
									passed = body.indexOf('"isPassed":true') !== -1;
								}
								if (passed) {
									vdoc.__cxapPassed = true;
									if (typeof win.__cxapOnPassed === "function") win.__cxapOnPassed();
								}
							} catch (e) {
								/* noop */
							}
						});
					}
					return oSend.apply(this, arguments);
				};
			}
			win.__cxapOnPassed = onPassed;
			if (vdoc.__cxapPassed) onPassed(); // 文档此前已完成过上报
		} catch (e) {
			/* 挂钩失败不影响主流程（还有图标与 ended 兜底） */
		}
	}

	function unhookReportCallback(vdoc) {
		try {
			const win = vdoc.defaultView;
			if (win) win.__cxapOnPassed = null;
		} catch (e) {
			/* noop */
		}
	}

	async function ensurePlay(video) {
		if (!video.paused) return;
		try {
			await video.play();
			return;
		} catch (e) {
			/* 自动播放被策略阻止 → 静音重试 */
		}
		video.muted = true;
		Log.warn("浏览器拦截了带声音的自动播放，已切换为静音播放");
		try {
			await video.play();
			return;
		} catch (e2) {
			throw new Error("无法启动视频播放：" + ((e2 && e2.message) || e2));
		}
	}

	function fmtTime(sec) {
		sec = Math.max(0, Math.floor(sec || 0));
		const m = Math.floor(sec / 60),
			s = sec % 60;
		return m + ":" + (s < 10 ? "0" : "") + s;
	}

	function fmtRate(rate) {
		const n = Math.round(Number(rate) * 100) / 100;
		return n + "x";
	}

	// ========================= 10.1 倍速能力探测 =========================

	/** 从视频 iframe 中取 VideoJS 播放器实例（找不到则返回 null） */
	function getVideoPlayer(vdoc) {
		try {
			const vw = vdoc.defaultView;
			const vj = vw && vw.videojs;
			if (typeof vj !== "function") return null;
			const video = vdoc.querySelector("video");
			let players = null;
			try {
				players = typeof vj.getPlayers === "function" ? vj.getPlayers() : vj.players;
			} catch (e) {
				players = vj.players;
			}
			const list = [];
			if (players && typeof players === "object") {
				Object.keys(players).forEach((k) => {
					if (players[k] && typeof players[k] === "object") list.push(players[k]);
				});
			}
			for (const p of list) {
				try {
					const el = typeof p.el === "function" ? p.el() : null;
					if (el && (!video || el.contains(video))) return p;
				} catch (e) {
					/* noop */
				}
			}
			return list[0] || null;
		} catch (e) {
			return null;
		}
	}

	/** 读取播放器声明的可用倍速（优先播放器配置，其次解析倍速菜单项） */
	function readRateOptions(vdoc, player) {
		const out = [];
		const push = (v) => {
			const n = Number(v);
			if (!isFinite(n) || n < 0.25 || n > 4) return;
			if (!out.some((x) => Math.abs(x - n) < 0.001)) out.push(n);
		};
		try {
			const rates =
				player && player.options_ && Array.isArray(player.options_.playbackRates)
					? player.options_.playbackRates
					: null;
			if (rates && rates.length) rates.forEach(push);
		} catch (e) {
			/* noop */
		}
		if (!out.length) {
			Dom.toArray(
				vdoc.querySelectorAll(".vjs-playback-rate .vjs-menu-content li, .vjs-menu-item"),
			).forEach((li) => {
				const txt = Dom.normText(li.textContent);
				const m = txt.match(/^(\d+(?:\.\d+)?)\s*x/i);
				if (m) push(parseFloat(m[1]));
			});
		}
		return out.sort((a, b) => a - b);
	}

	/** 找倍速菜单中对应速率的菜单项（直接派发 click 可走播放器官方切换逻辑） */
	function findRateMenuItem(vdoc, rate) {
		const items = Dom.toArray(
			vdoc.querySelectorAll(".vjs-playback-rate .vjs-menu-content li, .vjs-menu-item"),
		);
		for (const li of items) {
			const m = Dom.normText(li.textContent).match(/^(\d+(?:\.\d+)?)\s*x/i);
			if (m && Math.abs(parseFloat(m[1]) - rate) < 0.001) return li;
		}
		return null;
	}

	/** 当前生效倍速（播放器 API 优先，回退 video 元素） */
	function currentPlaybackRate(video, player) {
		try {
			if (player && typeof player.playbackRate === "function") return player.playbackRate();
		} catch (e) {
			/* noop */
		}
		try {
			return video.playbackRate;
		} catch (e) {
			return 1;
		}
	}

	/** 应用倍速：优先点击官方菜单项，再同步播放器 API 与原生 video 属性 */
	function applyPlaybackRate(vdoc, video, player, rate) {
		let viaMenu = false;
		const item = findRateMenuItem(vdoc, rate);
		if (item) {
			try {
				item.click();
				viaMenu = true;
			} catch (e) {
				/* noop */
			}
		}
		try {
			if (player && typeof player.playbackRate === "function") player.playbackRate(rate);
			else video.playbackRate = rate;
		} catch (e) {
			/* noop */
		}
		try {
			video.playbackRate = rate;
		} catch (e) {
			/* noop */
		}
		return viaMenu;
	}

	/** 播放器当前可见的“禁止倍速”提示（站点用 toolTipBox1 显示 rateTip / eryaRateTip） */
	function visibleRateTip(vdoc) {
		const sel = ".toolTipBox1, .toolTipBox1_1, .toolTipBox2, .ans-vjserrdisplay";
		const nodes = Dom.toArray(vdoc.querySelectorAll(sel));
		for (const el of nodes) {
			const txt = Dom.normText(el.textContent);
			if (txt.indexOf("倍速") === -1) continue;
			try {
				const cs = vdoc.defaultView.getComputedStyle(el);
				if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") continue;
				if (el.getBoundingClientRect().height > 0) return txt;
			} catch (e) {
				/* noop */
			}
		}
		return "";
	}

	/**
	 * 倍速控制器：
	 *  - 从播放器配置/倍速菜单读取课程实际开放的档位，逐档从高到低尝试
	 *  - 应用后持续观察：被重置或出现“禁止倍速”提示 → 判定不可用并回退 1x
	 *  - 播放暂停恢复、媒体源重载后自动重新应用（有限次数，避免与站点限制互相拉扯）
	 */
	function createSpeedController(vdoc, video, cardKey) {
		const player = getVideoPlayer(vdoc);
		const pref = store.config("video", VIDEO_DEFAULTS);
		let desired = 1; // 当前希望维持的倍速；1 表示不干预
		let blocked = false;
		let reapplyCount = 0;
		let lastApplyAt = 0;
		let stableSince = 0;
		let disposed = false;

		const videoEl = () => vdoc.querySelector("video") || video;
		const logLine = (level, msg) => {
			Log.use(cardKey);
			Log[level](msg);
		};

		try {
			if (player) player.videoAutoPlay = 0; // 关闭站点自动连播，避免与脚本切课竞争
		} catch (e) {
			/* noop */
		}

		async function observe(rate, windowMs) {
			await sleep(CFG.rateProbeDelay);
			const start = Date.now();
			while (Date.now() - start < windowMs) {
				if (S.stopRequested) throw STOP;
				if (visibleRateTip(vdoc)) return "blocked";
				if (Math.abs(currentPlaybackRate(videoEl(), player) - rate) > 0.01) return "reset";
				await sleep(220);
			}
			return "ok";
		}

		function block(reason) {
			blocked = true;
			desired = 1;
			reapplyCount = 0;
			applyPlaybackRate(vdoc, videoEl(), player, 1);
			logLine("warn", "该视频不允许倍速（" + reason + "），已回退 1x 播放");
		}

		/** 探测并开启最高可用倍速；返回最终生效倍速 */
		async function arm() {
			if (!pref.autoRate) {
				logLine("info", "自动倍速已关闭，按 1x 播放");
				return 1;
			}
			const options = readRateOptions(vdoc, player);
			const candidates = options.filter((r) => r > 1).sort((a, b) => b - a);
			if (!candidates.length) {
				logLine("skip", "未检测到可用倍速选项，保持 1x 播放");
				return 1;
			}
			logLine(
				"info",
				"检测到倍速档位：" + options.map(fmtRate).join(" / ") + "，尝试最高档",
			);
			const tried = candidates.slice(0, 3);
			for (const rate of tried) {
				if (S.stopRequested) throw STOP;
				logLine("info", "尝试 " + fmtRate(rate) + " 播放");
				applyPlaybackRate(vdoc, videoEl(), player, rate);
				lastApplyAt = Date.now();
				const verdict = await observe(rate, CFG.rateSettleTimeout);
				if (verdict === "ok") {
					desired = rate;
					reapplyCount = 0;
					stableSince = Date.now();
					logLine("ok", "已开启 " + fmtRate(rate) + " 倍速播放");
					return rate;
				}
				if (verdict === "blocked") {
					block("播放器提示不可启用倍速");
					return 1;
				}
				logLine("warn", fmtRate(rate) + " 被播放器重置，继续尝试较低档位");
			}
			block("可用档位均被播放器重置");
			return 1;
		}

		/** 播放中巡检：倍速被站点重置时先重试，反复重置则判定不支持 */
		function maintain() {
			if (disposed || blocked || desired <= 1) return;
			if (visibleRateTip(vdoc)) {
				block("播放器提示不可启用倍速");
				return;
			}
			const cur = currentPlaybackRate(videoEl(), player);
			if (Math.abs(cur - desired) < 0.01) {
				if (!stableSince) stableSince = Date.now();
				// 连续稳定 60s 才清零重试计数，避免「重置→重应用→再重置」无限循环
				else if (Date.now() - stableSince > 60000) reapplyCount = 0;
				return;
			}
			stableSince = 0;
			if (Date.now() - lastApplyAt < 1500) return; // 刚应用，给播放器留出稳定时间
			if (reapplyCount >= CFG.rateReapplyLimit) {
				block("倍速被反复重置");
				return;
			}
			reapplyCount++;
			applyPlaybackRate(vdoc, videoEl(), player, desired);
			lastApplyAt = Date.now();
			logLine("warn", "倍速被重置，已重新应用 " + fmtRate(desired) + "（" + reapplyCount + "/" + CFG.rateReapplyLimit + "）");
		}

		/** 暂停恢复后立即恢复倍速（不触发完整探测） */
		function onResume() {
			if (disposed || blocked || desired <= 1) return;
			applyPlaybackRate(vdoc, videoEl(), player, desired);
			lastApplyAt = Date.now();
		}

		const onLoadStart = () => {
			if (disposed || blocked || desired <= 1) return;
			// 媒体源切换/线路重载会把倍速重置为 1，延迟一点再应用
			setTimeout(() => {
				if (disposed || blocked || desired <= 1) return;
				applyPlaybackRate(vdoc, videoEl(), player, desired);
				lastApplyAt = Date.now();
			}, 350);
		};
		try {
			video.addEventListener("loadstart", onLoadStart);
		} catch (e) {
			/* noop */
		}

		function pause() {
			try {
				if (player && typeof player.pause === "function") player.pause();
			} catch (e) {
				/* noop */
			}
			try {
				const v = videoEl();
				if (v) v.pause();
			} catch (e) {
				/* noop */
			}
		}

		function dispose() {
			disposed = true;
			try {
				video.removeEventListener("loadstart", onLoadStart);
			} catch (e) {
				/* noop */
			}
		}

		return {
			arm,
			maintain,
			onResume,
			pause,
			dispose,
			getRate: () => currentPlaybackRate(videoEl(), player),
		};
	}

	/** 检测视频内弹题/互动弹窗（可能渲染在视频文档或外层卡片文档） */
	function detectVideoPopup(vdoc, containerDoc) {
		const docs = [vdoc, containerDoc].filter(Boolean);
		const sels = ["#topicList", "#topicType", "#topicContent", ".videoquiz", ".ans-videoquiz"];
		for (const d of docs) {
			for (const sel of sels) {
				let nodes = [];
				try {
					nodes = Dom.toArray(d.querySelectorAll(sel));
				} catch (e) {
					continue;
				}
				for (const el of nodes) {
					if (!Dom.isVisible(el)) continue;
					const txt = Dom.normText(el.textContent);
					if (txt.length >= 4 || el.querySelector("input,button,.option,.answer,.TiMu"))
						return el;
				}
			}
		}
		return null;
	}

	/** 暂停并等待站点完成最后一次进度上报，避免切课时中断请求触发页面重载 */
	async function pauseAndSettle(video, speedCtl) {
		try {
			if (speedCtl) speedCtl.pause();
		} catch (e) {
			/* noop */
		}
		try {
			if (video) video.pause();
		} catch (e) {
			/* noop */
		}
		await sleep(CFG.navSettleDelay);
	}

	/** 运行时关闭站点自身的自动连播（顶层变量），停止时恢复 */
	function disableSiteAutoNext() {
		try {
			if (!Object.prototype.hasOwnProperty.call(window, "__cxapAutoNextSaved")) {
				window.__cxapAutoNextSaved = window.videoAutoPlay;
			}
			window.videoAutoPlay = 0;
		} catch (e) {
			/* noop */
		}
	}

	function restoreSiteAutoNext() {
		try {
			if (Object.prototype.hasOwnProperty.call(window, "__cxapAutoNextSaved")) {
				window.videoAutoPlay = window.__cxapAutoNextSaved;
				delete window.__cxapAutoNextSaved;
			}
		} catch (e) {
			/* noop */
		}
	}

	/** 处理单个视频任务点（完成时返回判定来源） */
	async function handleVideoTask(job, cardKey) {
		if (!job.iframe) throw new Error("未找到视频载体 iframe");
		cardKey = cardKey || "v:" + (job.jobid || job.title);

		// A. 等待视频框与 video 元素
		const vdoc = await waitFor(
			() => {
				try {
					const d = job.iframe.contentDocument;
					if (d && d.readyState === "complete" && d.body && d.querySelector("video"))
						return d;
				} catch (e) {
					/* 跨域等情况返回 null */
				}
				return null;
			},
			{ timeout: CFG.videoFindTimeout, interval: 500, desc: "视频播放器加载" },
		);

		const video = vdoc.querySelector("video");
		const popupDoc = (job.iframe && job.iframe.ownerDocument) || vdoc;

		// B. 安装完成信号（事件驱动优先）
		const signals = { passed: false, iconDone: false };
		installReportHook(vdoc, () => {
			signals.passed = true;
		});
		let iconObs = watchIconDone(job.icon, () => {
			signals.iconDone = true;
		});
		let speedCtl = null;

		try {
			if (isIconDone(job.icon) || signals.iconDone) return "taskpoint"; // 进入时已完成（如上次异常退出）

			// C. 先以 1x 启动播放。实测：VideoJS 惰性加载，未播放时 duration 为 null。
			try {
				video.playbackRate = 1;
			} catch (e) {
				/* noop */
			}
			video.muted = !!store.get("mute", false);
			await ensurePlay(video);
			Log.use(cardKey);
			Log.info("开始播放");

			// D. 等待播放真正就绪（元数据加载或进度开始走）
			await waitFor(
				() => (isFinite(video.duration) && video.duration > 0) || video.currentTime > 0,
				{ timeout: 60000, interval: 500, desc: "视频开始加载" },
			);
			if (isFinite(video.duration) && video.duration > 0) {
				Log.use(cardKey);
				Log.info("时长 " + fmtTime(video.duration) + "，完成条件：观看 ≥ 总时长的 90%");
			}

			// E. 倍速探测（自动选择课程允许的最高档；不可用时回退 1x）
			speedCtl = createSpeedController(vdoc, video, cardKey);
			await speedCtl.arm();

			// F. 监控循环（1s 兜底轮询 + 事件信号）
			//    进度看门狗：实测暂停可能高频发生（CDN 抖动导致媒体源重载，不经过 video.pause()），
			//    因此不按"暂停次数"判失败，而是只要 currentTime 持续推进就一直恢复；
			//    只有长时间零进度才判定失败（重试→跳过）。
			let lastPct = -1,
				lastLogAt = 0,
				pauseResumes = 0,
				popupSince = 0;
			let progressAnchor = { t: video.currentTime, at: Date.now() };
			for (;;) {
				if (S.stopRequested) throw STOP;
				await sleep(CFG.monitorInterval);

				const v = vdoc.querySelector("video") || video;

				// 完成判定 1：任务点状态（图标 aria-label / 上报响应 isPassed）
				if (signals.passed || vdoc.__cxapPassed || signals.iconDone || isIconDone(job.icon)) {
					const viaPassed = signals.passed || vdoc.__cxapPassed;
					await pauseAndSettle(v, speedCtl);
					Log.use(cardKey);
					Log.info("检测到完成（" + (viaPassed ? "服务端 isPassed" : "页面任务点状态") + "）");
					return "taskpoint";
				}

				// 完成判定 2：视频播放完成 → 等待任务点状态同步
				if (
					v.ended ||
					(isFinite(v.duration) && v.duration > 0 && v.currentTime >= v.duration - 1.5)
				) {
					Log.use(cardKey);
					Log.info("播放完成，等待任务点状态更新…");
					let ok = false;
					try {
						ok = await waitFor(
							() =>
								signals.passed ||
								vdoc.__cxapPassed ||
								signals.iconDone ||
								isIconDone(job.icon),
							{ timeout: CFG.endedGraceTimeout, interval: 800, desc: "任务点状态同步" },
						);
					} catch (e) {
						if (e === STOP) throw e;
					}
					await pauseAndSettle(v, speedCtl);
					if (ok) {
						Log.use(cardKey);
						Log.info("检测到任务点完成");
						return "taskpoint";
					}
					Log.use(cardKey);
					Log.warn("任务点状态未更新，按视频播放完成处理（ended 兜底）");
					return "ended";
				}

				// 异常：播放出错
				if (v.error) throw new Error("视频播放出错（code=" + v.error.code + "）");

				// 视频内弹题：站点会暂停播放并等待作答；此脚本不代答，只明确等待并暂停进度看门狗
				const popup = detectVideoPopup(vdoc, popupDoc);
				if (popup) {
					if (!popupSince) {
						popupSince = Date.now();
						Log.use(cardKey);
						Log.warn(
							"检测到视频内弹题/互动弹窗，已暂停进度判定，请手动作答后继续（最长等待 " +
								Math.round(CFG.videoPopupWait / 60000) +
								" 分钟）",
						);
					}
					progressAnchor = { t: v.currentTime, at: Date.now() };
					Panel.setTask("视频内弹题：请手动作答");
					if (Date.now() - popupSince > CFG.videoPopupWait) {
						throw new Error(
							"视频内弹题超过 " +
								Math.round(CFG.videoPopupWait / 60000) +
								" 分钟未处理，放弃该任务点",
						);
					}
					continue;
				}
				if (popupSince) {
					popupSince = 0;
					Log.use(cardKey);
					Log.info("视频内弹题已处理，继续播放");
				}

				// 倍速巡检：被站点重置时重试/回退
				try {
					speedCtl.maintain();
				} catch (e) {
					/* 倍速维护失败不影响播放 */
				}

				// 进度看门狗：currentTime 在推进则刷新锚点，否则计时
				if (v.currentTime > progressAnchor.t + 0.5) {
					progressAnchor = { t: v.currentTime, at: Date.now() };
				} else if (Date.now() - progressAnchor.at > CFG.noProgressTimeout) {
					throw new Error(
						"视频超过 " +
							Math.round(CFG.noProgressTimeout / 60000) +
							" 分钟无进度推进（持续网络异常或交互阻塞），放弃该任务点",
					);
				}

				// 播放被暂停 → 自动恢复（不依赖暂停原因：失焦/CDN 重载/弹题均覆盖）
				if (v.paused) {
					if (pauseResumes >= CFG.maxPauseResumes) {
						throw new Error("视频反复暂停，已达到恢复上限（" + CFG.maxPauseResumes + " 次）");
					}
					pauseResumes++;
					Log.use(cardKey);
					Log.warn("检测到视频被暂停，自动恢复播放（第 " + pauseResumes + " 次）");
					v.muted = !!store.get("mute", false);
					await ensurePlay(v);
					try {
						speedCtl.onResume();
					} catch (e) {
						/* noop */
					}
					continue;
				}

				// 进度展示与节流日志（元数据未就绪时仅显示已播放时间）
				const hasDur = isFinite(v.duration) && v.duration > 0;
				const pct = hasDur ? Math.min(99, Math.floor((v.currentTime / v.duration) * 100)) : -1;
				const rate = speedCtl ? speedCtl.getRate() : 1;
				Panel.setTask(
					pct >= 0
						? "播放中 " +
								pct +
								"%（" +
								fmtTime(v.currentTime) +
								" / " +
								fmtTime(v.duration) +
								(rate > 1 ? "，" + fmtRate(rate) : "") +
								"）"
						: "播放中（" + fmtTime(v.currentTime) + (rate > 1 ? "，" + fmtRate(rate) : "") + "）",
				);
				if (pct >= 0 && pct !== lastPct && Date.now() - lastLogAt > CFG.progressLogInterval) {
					lastPct = pct;
					lastLogAt = Date.now();
					Log.use(cardKey);
					Log.info("播放进度：" + pct + "%" + (rate > 1 ? "（" + fmtRate(rate) + "）" : ""));
				}
			}
		} finally {
			unhookReportCallback(vdoc);
			try {
				if (speedCtl) speedCtl.dispose();
			} catch (e) {
				/* noop */
			}
			if (iconObs) {
				try {
					iconObs.disconnect();
				} catch (e) {
					/* noop */
				}
				S.observers = S.observers.filter((o) => o !== iconObs);
				iconObs = null;
			}
			try {
				if (video) video.pause();
			} catch (e) {
				/* noop */
			}
		}
	}

	// >>> 30-extract.js
	// ========================= 11. 题目提取（含混淆字体探测） =========================

	/** 题型关键词 → 归一化类型 */
	const QUESTION_TYPES = [
		{ key: "单选题", match: /单选|单项选择/ },
		{ key: "多选题", match: /多选|多项选择|不定项/ },
		{ key: "判断题", match: /判断/ },
		{ key: "填空题", match: /填空/ },
		{ key: "简答题", match: /简答|论述|名词解释|计算题|分析题|问答题/ },
		{ key: "连线题", match: /连线|匹配/ },
		{ key: "排序题", match: /排序/ },
	];

	/** qtype 属性 → 归一化类型（页面辅助信息） */
	const QTYPE_MAP = {
		0: "单选题",
		1: "多选题",
		2: "判断题",
		3: "填空题",
		4: "简答题",
		5: "简答题",
		6: "简答题",
		8: "连线题",
		9: "排序题",
	};

	function normalizeQuestionType(text, qtype) {
		const t = String(text || "");
		for (const def of QUESTION_TYPES) {
			if (def.match.test(t)) return def.key;
		}
		if (qtype != null && QTYPE_MAP[qtype]) return QTYPE_MAP[qtype];
		return "其他";
	}

	const Extract = {
		/**
		 * 从答题任务点 iframe 中定位真正的题目文档。
		 * 结构：work/index.html → iframe#frame_content → /mooc-ans/api/work 文档
		 */
		resolveWorkDoc(workIframe) {
			const workDoc = Dom.docOf(workIframe);
			if (!workDoc) return null;
			const inner = workDoc.querySelector(SEL.hiddenIframe);
			if (inner) {
				const d = Dom.docOf(inner);
				if (d) return d;
			}
			return workDoc; // 部分版本题目直接渲染在 work iframe 内
		},

		/** 等待题目文档与题目列表渲染完成 */
		async waitForQuestions(workIframe, timeout) {
			return waitFor(
				() => {
					const d = this.resolveWorkDoc(workIframe);
					if (!d) return null;
					if (!d.body || d.readyState !== "complete") return null;
					const list = d.querySelectorAll(SEL.question);
					if (!list.length) return null;
					// 至少有一道题具备题干结构，避免拿到骨架屏
					const ready = Dom.toArray(list).some((q) => q.querySelector(SEL.questionStemWrap));
					return ready ? d : null;
				},
				{
					timeout: timeout || CFG.workSettleTimeout,
					interval: 400,
					desc: "题目内容渲染",
				},
			);
		},

		/** 解析单道题 */
		parseQuestion(rootEl, idx, doc) {
			const typeEl = rootEl.querySelector(SEL.questionType);
			const stemEl = rootEl.querySelector(SEL.questionStem) || rootEl.querySelector(SEL.questionStemWrap);
			const firstOption = rootEl.querySelector(SEL.optionItem + "[qtype]");
			const qtype = firstOption ? firstOption.getAttribute("qtype") : null;

			const stemCloneText = stemEl ? Dom.normText(stemEl.textContent) : "";
			const typeText = typeEl ? Dom.normText(typeEl.textContent) : "";
			const typeKey = normalizeQuestionType(typeText, qtype);

			// 题干文本：剔除题型标签，避免污染
			let stemText = stemCloneText;
			if (typeText && stemText.startsWith(typeText)) stemText = stemText.slice(typeText.length).trim();

			const options = this.parseOptions(rootEl);
			const needBitmap =
				Dom.needsBitmap(stemEl) || options.some((o) => o.needBitmap);

			const parsed = {
				idx,
				seq: idx + 1,
				typeKey,
				qtype,
				rootEl,
				doc,
				stemEl,
				stemText,
				typeText,
				options,
				needBitmap,
				answered: options.some((o) => o.checked),
			};
			return parsed;
		},

		/** 解析选项列表 */
		parseOptions(rootEl) {
			const lists = Dom.toArray(rootEl.querySelectorAll(SEL.optionList));
			const out = [];
			lists.forEach((list) => {
				Dom.toArray(list.querySelectorAll(SEL.optionItem)).forEach((li) => {
					const labelEl = li.querySelector(SEL.optionLabel);
					const letter = labelEl
						? labelEl.getAttribute("data") || Dom.normText(labelEl.textContent)
						: "";
					if (!letter) return; // 非选项行（如说明文案）
					const bodyEl = li.querySelector(SEL.optionBody) || li;
					const imgCount = bodyEl.querySelectorAll("img").length;
					// 选项文本需排除字母标签本身
					const clone = bodyEl.cloneNode(true);
					const priceLabels = Dom.toArray(clone.querySelectorAll(SEL.optionLabel));
					priceLabels.forEach((n) => n.remove());
					const text = Dom.normText(clone.textContent);
					const checked = !!(
						(labelEl && labelEl.classList.contains("check_answer")) ||
						li.getAttribute("aria-checked") === "true" ||
						li.classList.contains("check_answer")
					);
					out.push({
						letter: String(letter).trim(),
						li,
						bodyEl,
						text,
						hasImage: imgCount > 0,
						imgCount,
						checked,
						needBitmap: Dom.needsBitmap(bodyEl),
					});
				});
			});
			return out;
		},

		/** 解析整个文档的所有题目 */
		parseAll(doc) {
			return Dom.toArray(doc.querySelectorAll(SEL.question)).map((q, i) =>
				this.parseQuestion(q, i, doc),
			);
		},
	};

	// >>> 31-render.js
	// ========================= 13. 题目渲染器（DOM → Canvas 位图） =========================
	//
	// 为什么必须用位图：
	//   学习通对题干/选项使用 font-cxsecret 字体做映射混淆，映射表随页面加载随机生成，
	//   静态码表无法破解；只有让浏览器按当前字体真实排版再截图，才能得到可读文本。
	// 实现方式：
	//   克隆题目 DOM → 内联原文档的计算样式（逐字体族保真）→ 图片转 dataURL →
	//   基于 Range.getClientRects() 逐行重绘到 canvas（不依赖 html2canvas，无外部依赖且布局精确）。

	const QuestionRenderer = (function () {
		let host = null;
		let styleInjected = false;

		const HOST_ID = "cxap-render-host";
		const CLS = {
			root: "cxq-root",
			stem: "cxq-stem",
			opt: "cxq-opt",
			letter: "cxq-opt-letter",
			body: "cxq-opt-body",
		};

		const STYLE = `
	.${CLS.root} { width: 100%; background: #fff; color: #1a1a1a;
	  font-family: "Microsoft YaHei", "PingFang SC", sans-serif; font-size: 14px; line-height: 1.7; }
	.${CLS.root} * { margin: 0; padding: 0; border: 0; float: none; background: transparent;
	  box-sizing: border-box; max-width: 100%; }
	.${CLS.stem} { margin-bottom: 9px; word-break: break-word; }
	.${CLS.stem} p { display: block; }
	.${CLS.stem} img { display: inline-block; vertical-align: middle; height: auto; }
	.${CLS.opt} { display: flex; align-items: flex-start; margin: 6px 0; }
	.${CLS.letter} { flex: 0 0 auto; margin-right: 8px; font-family: "Microsoft YaHei", sans-serif;
	  font-size: 14px; line-height: 1.7; color: #1a1a1a; }
	.${CLS.body} { flex: 1 1 auto; min-width: 0; word-break: break-word; }
	.${CLS.body} p { display: block; }
	.${CLS.body} img { display: inline-block; vertical-align: middle; height: auto; }
	`;

		function ensureHost() {
			if (host && host.isConnected) return host;
			host = document.createElement("div");
			host.id = HOST_ID;
			host.style.cssText =
				"position:fixed;left:-100000px;top:0;width:" +
				CFG.renderWidth +
				"px;z-index:-2147483647;background:#fff;pointer-events:none;";
			document.body.appendChild(host);
			S.panels.push(host);
			if (!styleInjected) {
				const st = document.createElement("style");
				st.textContent = STYLE;
				document.head.appendChild(st);
				styleInjected = true;
			}
			return host;
		}

		/** 把源元素的文字相关计算样式内联到克隆元素，保证字体族（含混淆字体）与颜色一致 */
		function mirrorTextStyles(srcEl, dstEl, srcWin) {
			let cs = null;
			try {
				cs = srcWin.getComputedStyle(srcEl);
			} catch (e) {
				/* noop */
			}
			if (!cs) return;
			const s = dstEl.style;
			s.fontFamily = cs.fontFamily;
			s.fontSize = cs.fontSize;
			s.fontStyle = cs.fontStyle;
			s.fontWeight = cs.fontWeight;
			s.lineHeight = cs.lineHeight;
			s.color = cs.color;
			s.letterSpacing = cs.letterSpacing;
			s.textAlign = cs.textAlign;
			s.textDecoration = cs.textDecorationLine || cs.textDecoration;
			s.whiteSpace = "pre-wrap";
			s.verticalAlign = "baseline";
			if (srcEl.tagName === "IMG") {
				s.display = "inline-block";
				s.verticalAlign = "middle";
				s.height = "auto";
			}
		}

		/** 递归克隆子树并逐节点镜像计算样式 */
		function cloneWithStyles(srcEl, srcWin) {
			const dst = srcEl.cloneNode(false);
			mirrorTextStyles(srcEl, dst, srcWin);
			Dom.toArray(srcEl.childNodes).forEach((child) => {
				if (child.nodeType === 1) {
					dst.appendChild(cloneWithStyles(child, srcWin));
				} else if (child.nodeType === 3) {
					dst.appendChild(srcEl.ownerDocument.createTextNode(child.nodeValue));
				}
			});
			return dst;
		}

		/** 构建离屏渲染 DOM：题干 + 逐行选项 */
		async function buildDom(question) {
			const h = ensureHost();
			const srcDoc = question.doc;
			const srcWin = srcDoc.defaultView;

			const root = document.createElement("div");
			root.className = CLS.root;

			// 题干
			const stemWrap = document.createElement("div");
			stemWrap.className = CLS.stem;
			if (question.stemEl) {
				stemWrap.appendChild(cloneWithStyles(question.stemEl, srcWin));
			} else {
				const fallback = document.createElement("div");
				fallback.textContent = question.stemText || "（题干读取失败）";
				stemWrap.appendChild(fallback);
			}
			root.appendChild(stemWrap);

			// 选项（重建为整洁的单行结构，避免原页面浮动布局带来的不确定性）
			question.options.forEach((opt) => {
				const row = document.createElement("div");
				row.className = CLS.opt;
				const letter = document.createElement("span");
				letter.className = CLS.letter;
				letter.textContent = opt.letter + ".";
				row.appendChild(letter);
				const body = document.createElement("div");
				body.className = CLS.body;
				body.appendChild(cloneWithStyles(opt.bodyEl, srcWin));
				row.appendChild(body);
				root.appendChild(row);
			});

			h.appendChild(root);

			// 图片转 dataURL，避免污染画布（同时绕过混合内容限制）
			await inlineImages(root);
			await ImageUtils.waitImages(root, 10000);

			return root;
		}

		/** 把容器内所有 img 的 src 换成 dataURL */
		async function inlineImages(root) {
			const imgs = Dom.toArray(root.querySelectorAll("img"));
			await Promise.all(
				imgs.map(async (img) => {
					const raw = img.getAttribute("data-original") || img.getAttribute("src") || "";
					if (!raw || /^data:/i.test(raw)) return;
					const dataUrl = await ImageUtils.fetchAsDataUrl(raw);
					if (dataUrl) {
						img.setAttribute("src", dataUrl);
					} else {
						// 拉取失败：留占位，避免整题渲染失败
						img.removeAttribute("src");
						img.style.cssText +=
							"display:inline-block;min-width:120px;height:22px;background:#eee;border:1px dashed #bbb;";
						img.setAttribute("alt", "[图片加载失败]");
						const ph = document.createElement("span");
						ph.textContent = "[图片加载失败]";
						ph.style.color = "#c0392b";
						img.replaceWith(ph);
					}
				}),
			);
		}

		/** 计算元素（或 DOMRect）相对基准矩形的偏移 */
		function relRect(el, base) {
			const r =
				typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : el;
			return {
				x: r.left - base.left,
				y: r.top - base.top,
				w: r.width,
				h: r.height,
			};
		}

		/** 单行文本：取文本节点每行的字符区间与几何 */
		function layoutTextNode(node) {
			const text = node.nodeValue || "";
			if (!text.trim()) return [];
			const doc = node.ownerDocument;
			const range = doc.createRange();
			range.selectNodeContents(node);
			const rects = Dom.toArray(range.getClientRects()).filter(
				(r) => r.height > 0 && (r.width > 0 || r.height > 0),
			);
			if (!rects.length) return [];
			if (rects.length === 1) {
				return [{ text: text.replace(/\s+/g, " "), rect: rects[0] }];
			}
			// 多行：二分定位每行覆盖的字符区间
			const lines = [];
			let start = 0;
			for (let i = 0; i < rects.length; i++) {
				if (start >= text.length) break;
				const targetTop = rects[i].top;
				let lo = start + 1,
					hi = text.length,
					best = start + 1;
				while (lo <= hi) {
					const mid = (lo + hi) >> 1;
					range.setStart(node, start);
					range.setEnd(node, mid);
					const rs = Dom.toArray(range.getClientRects()).filter((r) => r.height > 0);
					const ok = !rs.length || Math.abs(rs[rs.length - 1].top - targetTop) < 2;
					if (ok) {
						best = mid;
						lo = mid + 1;
					} else {
						hi = mid - 1;
					}
				}
				lines.push({ text: text.slice(start, best), rect: rects[i] });
				start = best;
			}
			if (start < text.length) {
				lines.push({ text: text.slice(start), rect: rects[rects.length - 1] });
			}
			return lines;
		}

		/** 递归收集绘制指令（保持 DOM 顺序，后绘制者覆盖先绘制者） */
		function collect(container, base) {
			const items = [];
			const srcWin = container.ownerDocument.defaultView;

			function walk(el) {
				const cs = srcWin.getComputedStyle(el);
				const bg = cs.backgroundColor;
				if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
					const r = relRect(el, base);
					if (r.w > 0 && r.h > 0) items.push({ type: "rect", rect: r, color: bg });
				}
				Dom.toArray(el.childNodes).forEach((child) => {
					if (child.nodeType === 3) {
						layoutTextNode(child).forEach((ln) => {
							if (!ln.text || !ln.text.trim()) return;
							const r = relRect(ln.rect, base);
							items.push({
								type: "text",
								text: ln.text,
								rect: r,
								color: cs.color,
								font: buildFont(cs),
							});
						});
					} else if (child.nodeType === 1) {
						if (child.tagName === "IMG") {
							const r = relRect(child, base);
							if (r.w > 0 && r.h > 0 && child.complete && child.naturalWidth > 0)
								items.push({ type: "img", el: child, rect: r });
							return;
						}
						if (child.tagName === "BR") return;
						walk(child);
					}
				});
			}
			walk(container);
			return items;
		}

		function buildFont(cs) {
			const style = cs.fontStyle && cs.fontStyle !== "normal" ? cs.fontStyle + " " : "";
			const weight =
				cs.fontWeight && cs.fontWeight !== "400" && cs.fontWeight !== "normal"
					? cs.fontWeight + " "
					: "";
			return style + weight + cs.fontSize + " " + cs.fontFamily;
		}

		/** 把收集到的指令绘制到 canvas */
		function paint(items, width, height) {
			const canvas = document.createElement("canvas");
			canvas.width = Math.max(1, Math.ceil(width));
			canvas.height = Math.max(1, Math.ceil(height));
			const ctx = canvas.getContext("2d");
			ctx.fillStyle = "#ffffff";
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			ctx.textBaseline = "alphabetic";

			for (const it of items) {
				try {
					if (it.type === "rect") {
						ctx.fillStyle = it.color;
						ctx.fillRect(it.rect.x, it.rect.y, it.rect.w, it.rect.h);
					} else if (it.type === "img") {
						ctx.drawImage(it.el, it.rect.x, it.rect.y, it.rect.w, it.rect.h);
					} else if (it.type === "text") {
						ctx.font = it.font;
						ctx.fillStyle = it.color;
						const m = ctx.measureText(it.text);
						const asc = m.actualBoundingBoxAscent || 0;
						const desc = m.actualBoundingBoxDescent || 0;
						const boxH = it.rect.h;
						const baseline =
							it.rect.y +
							(boxH - (asc + desc)) / 2 +
							asc; /* 按字形实际高度垂直居中对齐 */
						ctx.fillText(it.text, it.rect.x, baseline);
					}
				} catch (e) {
					/* 单条指令失败不影响整图 */
				}
			}
			return canvas;
		}

		/**
		 * 原生栅格化：把真实 DOM 交给浏览器排版引擎渲染成位图。
		 *
		 * 与 canvas 逐行重绘相比，这里用的是浏览器自己的文本排版（换行、公式、表格、MathML 全部与页面一致），
		 * 且把混淆字体的 @font-face 以 data: URL 直接嵌进 SVG，
		 * 不依赖任何字体注册流程 —— 从机制上杜绝「字体未生效→渲染出密文」这一类问题。
		 */
		async function captureNative(question, root) {
			const width = Math.max(1, Math.round(root.getBoundingClientRect().width));
			const height = Math.max(1, Math.round(root.getBoundingClientRect().height));
			// 固定宽度，保证 SVG 内布局与测量一致
			root.style.width = width + "px";

			const xml = new XMLSerializer().serializeToString(root);
			const fontCss = buildFontCss(question.doc);
			const svg =
				'<svg xmlns="http://www.w3.org/2000/svg" width="' +
				width +
				'" height="' +
				height +
				'" viewBox="0 0 ' +
				width +
				" " +
				height +
				'">' +
				"<style type=\"text/css\"><![CDATA[" +
				STYLE +
				"\n" +
				fontCss +
				"]]></style>" +
				'<foreignObject x="0" y="0" width="' +
				width +
				'" height="' +
				height +
				'">' +
				xml +
				"</foreignObject></svg>";

			const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
			const img = await loadImage(url, CFG.renderTimeout);
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext("2d", { willReadFrequently: true });
			ctx.fillStyle = "#ffffff";
			ctx.fillRect(0, 0, width, height);
			ctx.drawImage(img, 0, 0);
			return canvas;
		}

		/** 生成嵌入 SVG 的 @font-face 声明（含文档中所有字体，保证排版保真） */
		function buildFontCss(doc) {
			const faces = FontTools.collectFaces(doc);
			const out = [];
			faces.forEach((src, family) => {
				const abs = /^data:/i.test(src) ? src : Dom.absUrl(src, doc);
				out.push(
					'@font-face{font-family:"' +
						family.replace(/"/g, "") +
						'";src:url("' +
						abs +
						'");}',
				);
			});
			return out.join("\n");
		}

		function loadImage(url, timeout) {
			return withTimeout(
				new Promise((resolve, reject) => {
					const img = new Image();
					img.onload = () => resolve(img);
					img.onerror = () => reject(new Error("SVG 图片解码失败"));
					img.src = url;
				}),
				timeout,
				"原生栅格化",
			);
		}

		/** 画布是否有内容（避免把空白图发给模型） */
		function hasInk(canvas) {
			try {
				const ctx = canvas.getContext("2d", { willReadFrequently: true });
				const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
				let ink = 0;
				for (let i = 0; i < d.length; i += 4) {
					if (d[i] < 220 || d[i + 1] < 220 || d[i + 2] < 220) {
						if (++ink > 60) return true;
					}
				}
				return false;
			} catch (e) {
				return true; // 读取失败时不阻断流程
			}
		}

		/**
		 * 探针渲染：用与正式渲染完全相同的管线（native=SVG 内嵌字体 / canvas=顶层注册字体）
		 * 渲染一段密文字符，再与系统字体渲染结果比较，判断混淆字体是否真的生效。
		 */
		async function probeEffective(question, probeText, method) {
			const doc = question.doc;
			const family = FontTools.resolveSecretFamily(doc);
			if (!family) return true;

			if (method === "canvas") {
				return FontTools.isFontEffective('"' + family + '"', probeText);
			}

			// native：走 SVG + foreignObject，验证内嵌字体确实参与排版
			try {
				const w = 300;
				const h = 60;
				const inner =
					'<div xmlns="http://www.w3.org/1999/xhtml" style="margin:0;padding:0;' +
					"width:" +
					w +
					"px;height:" +
					h +
					"px;background:#fff;color:#000;font-size:40px;line-height:60px;" +
					"white-space:nowrap;font-family:'" +
					family.replace(/'/g, "") +
					"';\">" +
					escapeXml(probeText) +
					"</div>";
				const svg =
					'<svg xmlns="http://www.w3.org/2000/svg" width="' +
					w +
					'" height="' +
					h +
					'"><style type="text/css"><![CDATA[' +
					buildFontCss(doc) +
					"]]></style>" +
					'<foreignObject x="0" y="0" width="' +
					w +
					'" height="' +
					h +
					'">' +
					inner +
					"</foreignObject></svg>";
				const img = await loadImage(
					"data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg),
					8000,
				);
				const a = document.createElement("canvas");
				a.width = w;
				a.height = h;
				const actx = a.getContext("2d", { willReadFrequently: true });
				actx.fillStyle = "#fff";
				actx.fillRect(0, 0, w, h);
				actx.drawImage(img, 0, 0);
				const da = actx.getImageData(0, 0, w, h).data;

				const sys = FontTools._probeCanvas('"Microsoft YaHei"', probeText);
				let diff = 0;
				for (let i = 0; i < da.length; i += 4) {
					if (Math.abs(da[i] - sys[i]) > 60) diff++;
				}
				// 只要渲染出的字形与系统字体有显著差异，就说明混淆字体确实生效
				return diff > 30;
			} catch (e) {
				return false;
			}
		}

		function escapeXml(s) {
			return String(s)
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;");
		}

		/**
		 * 渲染正确性自检（防止把「混淆后的密文」当成题目发给模型）。
		 *
		 * 原理：混淆字体只覆盖有限码点（字体 cmap），这些码点就是被替换掉的字符。
		 *  - 题目文本里没有任何 cmap 覆盖的字符 → 不存在混淆，渲染必然忠实
		 *  - 存在 → 用这些字符做探针，比较「混淆字体渲染」与「系统字体渲染」的位图；
		 *    两者一致说明字体没生效（渲染出的会是密文），判为失败
		 */
		async function checkObfuscationResolved(question, canvas, method) {
			const doc = question.doc;
			const family = FontTools.resolveSecretFamily(doc);
			if (!family) return { ok: true, reason: "no-secret-font" };

			const text = collectText(question);
			const ciphers = FontTools.cipherCharsIn(doc, text);
			if (!ciphers.length) return { ok: true, reason: "no-obfuscated-chars" };

			const probe = ciphers.slice(0, 8).join("");
			const effective = await probeEffective(question, probe, method);
			if (!effective) {
				return { ok: false, reason: "font-not-applied", probe };
			}
			if (canvas && !hasInk(canvas)) {
				return { ok: false, reason: "empty-render", probe };
			}
			return { ok: true, reason: "ok", ciphers: ciphers.length };
		}

		/** 收集题目全部可见文本（题干 + 选项） */
		function collectText(question) {
			let s = question.stemText || "";
			if (question.stemEl) s += " " + Dom.normText(question.stemEl.textContent);
			(question.options || []).forEach((o) => {
				s += " " + o.text;
				try {
					s += " " + Dom.normText(o.bodyEl.textContent);
				} catch (e) {
					/* noop */
				}
			});
			return s;
		}

		/**
		 * 渲染一道题 → dataURL 数组（超长题干自动切分）。
		 * 返回 { images, width, height, slices, method, ciphers }
		 */
		async function render(question) {
			let root = null;
			let method = "native";
			let canvas = null;
			try {
				// 顶层文档也注册一份混淆字体：既是 canvas 兜底路径的前提，也是自检探针的依据
				const reg = await FontTools.registerSecretFont(question.doc, document);
				if (!reg) Log.warn("混淆字体未能注册到顶层文档，将主要依赖原生栅格化路径");

				root = await withTimeout(buildDom(question), CFG.renderTimeout, "题目构建");

				try {
					canvas = await captureNative(question, root);
				} catch (e) {
					Log.warn("原生栅格化失败（" + e.message + "），回退到 canvas 渲染");
					method = "canvas";
					const base = root.getBoundingClientRect();
					const items = collect(root, base);
					canvas = paint(items, base.width, base.height);
				}

				// 强制自检：字体未生效则不予发送（宁可不作答，也不能把密文喂给模型）
				const check = await checkObfuscationResolved(question, canvas, method);
				if (!check.ok) {
					throw new Error(
						check.reason === "empty-render"
							? "渲染结果为空白"
							: "字体混淆未还原（探针字符「" +
								check.probe +
								"」渲染后未发生变化），图像会显示密文，已拒绝发送",
					);
				}

				const scaled = ImageUtils.scaleCanvas(canvas, CFG.imageMaxWidth);
				const slices = ImageUtils.sliceCanvas(
					scaled,
					CFG.renderMaxHeight,
					CFG.renderTileOverlap,
				);
				return {
					images: slices.map((c) => ImageUtils.canvasToDataUrl(c, "png")),
					width: scaled.width,
					height: scaled.height,
					slices: slices.length,
					method,
					ciphers: check.ciphers || 0,
				};
			} finally {
				if (root && root.parentNode) root.parentNode.removeChild(root);
			}
		}

		return { render, ensureHost, collectText, checkObfuscationResolved };
	})();

	// >>> 32-image.js
	// ========================= 12. 图片工具（跨域下载 / 尺寸处理） =========================

	const ImageUtils = {
		/** 通过 GM_xmlhttpRequest 取二进制（扩展层发起，不受页面 CORS 限制） */
		_fetchBinaryGM(url) {
			return new Promise((resolve, reject) => {
				if (typeof GM_xmlhttpRequest !== "function")
					return reject(new Error("GM_xmlhttpRequest 不可用"));
				GM_xmlhttpRequest({
					method: "GET",
					url,
					responseType: "arraybuffer",
					timeout: 30000,
					onload(res) {
						if (res.status >= 200 && res.status < 300 && res.response)
							resolve({ buf: res.response, type: res.responseHeaders });
						else reject(new Error("HTTP " + res.status));
					},
					onerror: () => reject(new Error("网络错误")),
					ontimeout: () => reject(new Error("请求超时")),
				});
			});
		},

		/** 通过页面 fetch 取二进制（同源或服务端已放行 CORS 时可用） */
		async _fetchBinaryPage(url) {
			const res = await fetch(url, { credentials: "omit", mode: "cors" });
			if (!res.ok) throw new Error("HTTP " + res.status);
			return { buf: await res.arrayBuffer(), type: res.headers.get("content-type") };
		},

		_mimeOf(url, type) {
			if (type && /^image\//i.test(type)) return type.split(";")[0];
			const m = String(url).match(/\.(png|jpe?g|gif|webp|bmp|svg)(?:\?|#|$)/i);
			if (!m) return "image/png";
			const ext = m[1].toLowerCase();
			if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
			if (ext === "svg") return "image/svg+xml";
			return "image/" + ext;
		},

		/** ArrayBuffer → base64 */
		_b64(buf) {
			const bytes = new Uint8Array(buf);
			let bin = "";
			const chunk = 0x8000;
			for (let i = 0; i < bytes.length; i += chunk) {
				bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
			}
			return btoa(bin);
		},

		_cache: new Map(), // url → dataUrl

		/** 拉取图片并转换为 data URL（供 canvas 使用，避免污染画布） */
		async fetchAsDataUrl(rawUrl) {
			const url = Dom.httpsUrl(rawUrl);
			if (!url) return null;
			if (this._cache.has(url)) return this._cache.get(url);
			let out = null;
			try {
				const r = await this._fetchBinaryGM(url);
				out = "data:" + this._mimeOf(url, r.type) + ";base64," + this._b64(r.buf);
			} catch (e) {
				try {
					const r2 = await this._fetchBinaryPage(url);
					out = "data:" + this._mimeOf(url, r2.type) + ";base64," + this._b64(r2.buf);
				} catch (e2) {
					out = null;
				}
			}
			this._cache.set(url, out);
			return out;
		},

		/** 等待容器内所有图片加载完成（含失败） */
		async waitImages(container, timeout) {
			const imgs = Dom.toArray(container.querySelectorAll("img"));
			if (!imgs.length) return;
			const wait = (img) =>
				new Promise((resolve) => {
					if (img.complete) return resolve();
					const done = () => {
						img.removeEventListener("load", done);
						img.removeEventListener("error", done);
						resolve();
					};
					img.addEventListener("load", done);
					img.addEventListener("error", done);
				});
			try {
				await withTimeout(Promise.all(imgs.map(wait)), timeout || 8000, "图片加载");
			} catch (e) {
				/* 超时也继续，缺图不影响其余内容 */
			}
		},

		/** 把 canvas 缩放到目标宽度并降采样（返回新 canvas） */
		scaleCanvas(src, maxWidth) {
			if (!maxWidth || src.width <= maxWidth) return src;
			const ratio = maxWidth / src.width;
			const out = document.createElement("canvas");
			out.width = Math.round(src.width * ratio);
			out.height = Math.round(src.height * ratio);
			const ctx = out.getContext("2d");
			ctx.imageSmoothingEnabled = true;
			ctx.imageSmoothingQuality = "high";
			ctx.fillStyle = "#fff";
			ctx.fillRect(0, 0, out.width, out.height);
			ctx.drawImage(src, 0, 0, out.width, out.height);
			return out;
		},

		/** canvas → PNG dataURL（无损原图，题目文字与公式不失真） */
		canvasToDataUrl(canvas) {
			return canvas.toDataURL("image/png");
		},

		/** 纵向切分长图（含重叠），返回 dataURL 数组 */
		sliceCanvas(canvas, maxHeight, overlap) {
			const max = maxHeight || CFG.renderMaxHeight;
			if (canvas.height <= max) return [canvas];
			const out = [];
			const step = Math.max(64, max - (overlap || CFG.renderTileOverlap));
			for (let y = 0; y < canvas.height; y += step) {
				const h = Math.min(max, canvas.height - y);
				if (h < 40) break;
				const c = document.createElement("canvas");
				c.width = canvas.width;
				c.height = h;
				const ctx = c.getContext("2d");
				ctx.fillStyle = "#fff";
				ctx.fillRect(0, 0, c.width, c.height);
				ctx.drawImage(canvas, 0, -y);
				out.push(c);
				if (y + h >= canvas.height) break;
			}
			return out;
		},
	};

	// >>> 40-llm.js
	// ========================= 14. LLM 客户端（OpenAI 兼容：Chat Completions / Responses） =========================
	//
	// 内部统一消息格式：
	//   { role: 'system'|'user'|'assistant', content: [ {type:'text', text}, {type:'image', dataUrl} ] }

	const LLM = (function () {
		/** 拼接最终请求地址（容忍用户填 /v1、完整路径或不带版本号） */
		function endpoint(base, style) {
			let b = String(base || "").trim().replace(/\/+$/, "");
			const suffix = style === "responses" ? "/responses" : "/chat/completions";
			if (b.endsWith(suffix)) return b;
			if (/\/(chat\/completions|responses|completions)$/.test(b)) {
				return b.replace(/\/(chat\/completions|responses|completions)$/, suffix);
			}
			const m = b.match(/^https?:\/\/[^/]+(\/.*)?$/i);
			const path = (m && m[1]) || "";
			if (!path || path === "/" || path === "/v1/") b += "/v1";
			return b + suffix;
		}

		/** 内部消息 → Chat Completions 格式 */
		function toChatMessages(messages) {
			return messages.map((m) => {
				if (typeof m.content === "string") return { role: m.role, content: m.content };
				const parts = m.content.map((c) => {
					if (c.type === "image")
						return {
							type: "image_url",
							image_url: { url: c.dataUrl, detail: c.detail || "high" },
						};
					return { type: "text", text: c.text || "" };
				});
				return { role: m.role, content: parts };
			});
		}

		/** 内部消息 → Responses API 格式 */
		function toResponsesPayload(messages) {
			const instructions = [];
			const input = [];
			messages.forEach((m) => {
				if (m.role === "system") {
					instructions.push(
						typeof m.content === "string"
							? m.content
							: m.content.map((c) => c.text || "").join("\n"),
					);
					return;
				}
				const content =
					typeof m.content === "string"
						? [{ type: "input_text", text: m.content }]
						: m.content.map((c) =>
								c.type === "image"
									? { type: "input_image", image_url: c.dataUrl, detail: c.detail || "high" }
									: { type: "input_text", text: c.text || "" },
							);
				input.push({ role: m.role, content });
			});
			return { instructions: instructions.join("\n"), input };
		}

		/** 从响应 JSON 中提取文本 */
		function pickText(data, style) {
			if (!data) return "";
			if (style === "responses") {
				if (typeof data.output_text === "string" && data.output_text) return data.output_text;
				const out = [];
				Dom.toArray(data.output || []).forEach((item) => {
					// 只取助手的 message 项；reasoning/thinking 项的正文不参与答案解析
					if (item.type && item.type !== "message") return;
					Dom.toArray(item.content || []).forEach((c) => {
						if (typeof c.text !== "string") return;
						if (c.type && c.type !== "output_text" && c.type !== "text") return;
						out.push(c.text);
					});
				});
				if (out.length) return out.join("");
				// 部分兼容实现仍返回 choices
			}
			const ch = (data.choices || [])[0];
			if (!ch) return "";
			const msg = ch.message || ch.delta || {};
			if (typeof msg.content === "string") return msg.content;
			if (Array.isArray(msg.content)) {
				return msg.content
					.map((c) => (typeof c === "string" ? c : c.text || ""))
					.join("");
			}
			if (typeof ch.text === "string") return ch.text;
			return "";
		}

		/** 是否运行在油猴等支持 GM_xmlhttpRequest 的环境 */
		function hasGM() {
			return typeof GM_xmlhttpRequest === "function";
		}

		/**
		 * 消息中是否出现 "json" 字样（图片内容不计）。
		 * OpenAI 兼容接口在启用 json_object 输出格式时强制要求提示词包含该词。
		 */
		function messagesMentionJson(messages) {
			return Dom.toArray(messages).some((m) => {
				if (typeof m.content === "string") return /json/i.test(m.content);
				return Dom.toArray(m.content).some(
					(c) => c && c.type !== "image" && /json/i.test(c.text || ""),
				);
			});
		}

		/**
		 * 判断错误是否属于「接口不支持 JSON 输出格式」。
		 * 必须同时提到格式相关字段与不支持语义 —— 否则像 invalid_request_error
		 * 这类通用错误类型也会被误判为不支持，导致无谓的降级重试。
		 */
		function isJsonFormatUnsupported(text) {
			const t = String(text || "");
			if (!/(json|response_?format|text\.format)/i.test(t)) return false;
			return /unsupported|not\s+support(ed)?|does\s*not\s+support|unknown\s+(parameter|field|argument)|unrecognized|不支持/i.test(
				t,
			);
		}

		/** 检查请求环境；返回 { ok, fatal, reason }（fatal 表示重试无意义） */
		function preflight(url) {
			if (hasGM()) return { ok: true };
			// 无 GM 时只能走页面 fetch，受同源策略与混合内容限制
			try {
				const page = new URL(location.href);
				const target = new URL(url);
				// 本地回环地址属于「潜在可信源」，即便页面是 HTTPS 也不会被混合内容拦截
				const isLoopback = /^(localhost|127(\.\d+){3}|\[::1\])$/i.test(target.hostname);
				if (page.protocol === "https:" && target.protocol === "http:" && !isLoopback) {
					return {
						ok: false,
						fatal: true,
						reason:
							"当前不在油猴环境中运行（GM_xmlhttpRequest 不可用），且页面为 HTTPS 而接口为 HTTP，" +
							"请求被浏览器「混合内容」策略拦截。" +
							"请在 Tampermonkey 中安装本脚本后使用，或将接口地址改为 HTTPS。",
					};
				}
				if (page.origin !== target.origin && !isLoopback) {
					return {
						ok: false,
						fatal: true,
						reason:
							"当前不在油猴环境中运行（GM_xmlhttpRequest 不可用），跨域请求 " +
							target.origin +
							" 被浏览器拦截。请在 Tampermonkey 中安装本脚本后使用。",
					};
				}
			} catch (e) {
				/* 解析失败则继续尝试 */
			}
			return { ok: true };
		}

		/** 底层单次 HTTP 请求（GM_xmlhttpRequest 优先，绕过页面 CORS 与混合内容限制） */
		function httpPost(url, headers, body, timeout) {
			const payload = JSON.stringify(body);
			return new Promise((resolve, reject) => {
				if (hasGM()) {
					GM_xmlhttpRequest({
						method: "POST",
						url,
						headers,
						data: payload,
						timeout: timeout || CFG.llmTimeout,
						onload(res) {
							resolve({ status: res.status, text: res.responseText || "" });
						},
						onerror: () => {
							const err = new Error(
								"网络错误：GM_xmlhttpRequest 无法连接到 " +
									url +
									"（请检查地址可达性与 Tampermonkey 的 @connect 授权）",
							);
							reject(err);
						},
						ontimeout: () =>
							reject(new Error("请求超时（" + (timeout || CFG.llmTimeout) + "ms）")),
					});
					return;
				}
				const ctrl = new AbortController();
				const timer = setTimeout(() => ctrl.abort(), timeout || CFG.llmTimeout);
				fetch(url, {
					method: "POST",
					headers,
					body: payload,
					signal: ctrl.signal,
				})
					.then(async (r) => resolve({ status: r.status, text: await r.text() }))
					.catch((e) => {
						const raw = (e && e.message) || String(e);
						const hint =
							raw === "Failed to fetch"
								? "（通常是「混合内容」被拦截、跨域受限或地址不可达；" +
									"请确认已在 Tampermonkey 中运行本脚本）"
								: "";
						const err = new Error("网络错误：" + raw + hint);
						err.fatal = true; // 网络层失败几乎都是环境/地址问题，重试无意义
						reject(err);
					})
					.finally(() => clearTimeout(timer));
			});
		}

		function buildHeaders(cfg) {
			const h = { "Content-Type": "application/json" };
			if (cfg.apiKey) h["Authorization"] = "Bearer " + cfg.apiKey;
			if (cfg.extraHeaders) {
				const extra = safeParse(cfg.extraHeaders, null);
				if (extra && typeof extra === "object") {
					Object.keys(extra).forEach((k) => {
						h[k] = String(extra[k]);
					});
				}
			}
			return h;
		}

		function formatError(status, text) {
			let msg = String(text || "").slice(0, 400);
			try {
				const j = JSON.parse(text);
				const m = j.error && (j.error.message || j.error.code);
				if (m) msg = m;
				else if (j.message) msg = j.message;
			} catch (e) {
				/* 保留原文 */
			}
			const hint =
				status === 401
					? "（API Key 无效或未授权）"
					: status === 404
						? "（接口地址不存在，请检查 Base URL 与接口风格）"
						: status === 429
							? "（触发限流或额度不足）"
							: "";
			return "HTTP " + status + hint + "：" + msg;
		}

		/**
		 * 发起一次对话请求。
		 * @param {object} opts { config, messages, timeout, maxTokens, jsonMode }
		 * @returns {Promise<{text:string, raw:object}>}
		 */
		async function chat(opts) {
			const cfg = opts.config || store.config("llm", LLM_DEFAULTS);
			const style = cfg.apiStyle === "responses" ? "responses" : "chat";
			const url = endpoint(cfg.baseUrl, style);
			const headers = buildHeaders(cfg);
			let wantJson = opts.jsonMode != null ? opts.jsonMode : cfg.jsonMode !== false;
			const maxTokens = opts.maxTokens || cfg.maxTokens || 2048;

			// 环境预检：混合内容 / 跨域等不可恢复问题直接失败，避免无意义的重试等待
			const pf = preflight(url);
			if (!pf.ok) {
				const err = new Error(pf.reason);
				err.fatal = true;
				throw err;
			}

			// 接口硬性要求：使用 json_object 输出格式时，提示词里必须出现 "json" 字样，
			// 否则会直接返回 400（Prompt must contain the word 'json'）。
			// 与其发出去被拒再降级，不如提前判断，省掉一次必然失败的请求。
			if (wantJson && !messagesMentionJson(opts.messages)) {
				Log.warn('提示词未包含 "json" 字样，已自动关闭 JSON 输出模式（接口限制）');
				wantJson = false;
			}

			const body = {};
			body.model = cfg.model;
			if (style === "responses") {
				const rp = toResponsesPayload(opts.messages);
				if (rp.instructions) body.instructions = rp.instructions;
				body.input = rp.input;
				body.max_output_tokens = maxTokens;
				if (wantJson) body.text = { format: { type: "json_object" } };
			} else {
				body.messages = toChatMessages(opts.messages);
				body.max_tokens = maxTokens;
				if (wantJson) body.response_format = { type: "json_object" };
			}
			if (style === "responses") body.temperature = cfg.temperature;
			else body.temperature = cfg.temperature;

			let lastErr = null;
			const attempts = Math.max(1, opts.retries || CFG.llmMaxRetries);
			for (let i = 1; i <= attempts; i++) {
				if (S.stopRequested) throw STOP;
				try {
					const res = await httpPost(url, headers, body, opts.timeout || CFG.llmTimeout);
					if (res.status >= 200 && res.status < 300) {
						const data = safeParse(res.text, null);
						if (!data) throw new Error("响应不是合法 JSON：" + res.text.slice(0, 200));
						return { text: pickText(data, style), raw: data };
					}
					// JSON 模式确实不被接口支持时，降级为普通文本重试一次
					if (res.status >= 400 && wantJson && isJsonFormatUnsupported(res.text)) {
						Log.warn("接口不支持 JSON 输出模式，已自动降级为普通文本模式");
						delete body.response_format;
						delete body.text;
						wantJson = false;
						i--; // 不计入重试次数
						continue;
					}
					const err = new Error(formatError(res.status, res.text));
					err.status = res.status;
					// 4xx（除限流）不做无意义重试
					if (res.status >= 400 && res.status < 500 && res.status !== 429) throw err;
					lastErr = err;
				} catch (e) {
					if (e === STOP) throw e;
					if (e.fatal) throw e; // 环境/地址类问题，重试无意义
					if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) throw e;
					lastErr = e;
				}
				if (i < attempts) {
					const wait = CFG.llmRetryDelay * Math.pow(2, i - 1);
					Log.warn("LLM 请求失败，将在 " + Math.round(wait / 1000) + "s 后重试（" + i + "/" + attempts + "）");
					await sleep(wait);
				}
			}
			throw lastErr || new Error("LLM 请求失败");
		}

		/** 从模型输出中稳健地提取 JSON */
		function extractJson(text) {
			if (!text) return null;
			let s = String(text).trim();
			const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
			if (fence) s = fence[1].trim();
			try {
				return JSON.parse(s);
			} catch (e) {
				/* 继续尝试截取 */
			}
			const start = s.indexOf("{");
			const end = s.lastIndexOf("}");
			if (start >= 0 && end > start) {
				try {
					return JSON.parse(s.slice(start, end + 1));
				} catch (e2) {
					/* noop */
				}
				// 容忍尾随逗号
				try {
					return JSON.parse(s.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1"));
				} catch (e3) {
					/* noop */
				}
			}
			return null;
		}

		/** 按字符数粗估 base64 图片体积（用于日志） */
		function estimatePayloadKB(messages) {
			let chars = 0;
			messages.forEach((m) => {
				if (typeof m.content === "string") chars += m.content.length;
				else
					m.content.forEach((c) => {
						chars += c.type === "image" ? (c.dataUrl || "").length + 40 : (c.text || "").length;
					});
			});
			return Math.round(chars / 1024);
		}

		return {
			chat,
			extractJson,
			estimatePayloadKB,
			endpoint,
			hasGM,
			preflight,
			messagesMentionJson,
			isJsonFormatUnsupported,
		};
	})();

	// >>> 41-provider.js
	// ========================= 15. 答案获取（提示词编排 + 结果解析） =========================

	const AnswerProvider = (function () {
		const SYSTEM_PROMPT = `你是一个严谨的在线考试答题助手，服务于中文高校课程测验。

	【最重要的前提】
	题目内容来自网页截图或网页文本。网页为了防作弊，对题干和选项中的部分文字使用了自定义字体做字符映射，
	因此在纯文本里这些字会显示为乱码（例如「壋于」「壖壗壔函壕」这类生僻字），但它们在截图中显示是正常的。
	请**只依据图片中实际显示的文字**来理解题意，不要试图猜测乱码文本的原意，也不要把乱码当作题目内容的一部分。
	如果一道题既给了文本又给了图片，以图片为准。

	【任务】
	对每一道题给出你的答案。

	【输出格式】
	只输出一个 JSON 对象，不要输出任何解释性文字、不要使用代码块围栏之外的说明。结构如下：
	{
	  "answers": [
	    {
	      "seq": 1,
	      "type": "单选题",
	      "answer": "B",
	      "confidence": 0.93,
	      "reason": "不超过 20 字的简要依据"
	    }
	  ]
	}

	【各题型的 answer 写法】
	- 单选题：单个大写选项字母，如 "B"
	- 多选题：多个大写选项字母连写，按字母顺序，不带任何分隔符，如 "ACD"
	- 判断题：单个字母（若选项为 A.正确 / B.错误 之类，就填对应字母）
	- 填空题：按空顺序给出内容数组，如 ["答案1","答案2"]
	- 其他题型：给出你认为最合适的文本

	【要求】
	- 必须为每一道题都输出一个对象，seq 与题目编号严格对应。
	- 选项字母必须来自题目中真实存在的选项，不要编造。
	- 无法确定的题目也要给出最佳猜测，并用较低的 confidence 标注，不要省略。
	- reason 用中文，简短。`;

		/** 把一组题目组织成一条 user 消息（文本 + 图片混合） */
		function buildUserMessage(items) {
			const content = [];
			content.push({
				type: "text",
				text:
					"下面是第 " +
					items[0].seq +
					" 到第 " +
					items[items.length - 1].seq +
					" 题，共 " +
					items.length +
					" 道。请逐题作答，并按约定返回 JSON。",
			});

			items.forEach((it) => {
				const head = "=== 第 " + it.seq + " 题 ===";
				if (it.images && it.images.length) {
					content.push({
						type: "text",
						text:
							head +
							"\n题型：" +
							it.typeKey +
							(it.images.length > 1
								? "\n（题目较长，已纵向切成 " + it.images.length + " 张图，按顺序拼接阅读）"
								: ""),
					});
					it.images.forEach((d) => content.push({ type: "image", dataUrl: d }));
					// 附带可读的辅助信息（选项字母表，便于模型对齐）
					const letters = it.options.map((o) => o.letter).join(" ");
					if (letters) {
						content.push({
							type: "text",
							text:
								"本题共 " +
								it.options.length +
								" 个选项，选项字母依次为：" +
								letters +
								"。answer 只能用这些字母。",
						});
					}
				} else {
					content.push({ type: "text", text: head + "\n" + it.text });
				}
			});

			return { role: "user", content };
		}

		/** 解析模型返回，产出 seq → 答案 的映射 */
		function parseAnswers(text) {
			const out = new Map();
			const data = LLM.extractJson(text);
			if (!data) return out;

			let list = null;
			if (Array.isArray(data)) list = data;
			else if (Array.isArray(data.answers)) list = data.answers;
			else if (Array.isArray(data.data)) list = data.data;
			else if (data.result && Array.isArray(data.result.answers)) list = data.result.answers;

			if (list) {
				list.forEach((it) => {
					if (!it) return;
					const seq = parseInt(it.seq != null ? it.seq : it.index, 10);
					if (!seq || isNaN(seq)) return;
					out.set(seq, {
						answer: normalizeAnswer(it.answer),
						confidence: typeof it.confidence === "number" ? it.confidence : null,
						reason: it.reason || "",
						type: it.type || "",
					});
				});
				return out;
			}

			// 兜底：{"1":"B","2":"AC"} 这类扁平结构
			Object.keys(data).forEach((k) => {
				const seq = parseInt(k, 10);
				if (!seq || isNaN(seq)) return;
				const v = data[k];
				const ans =
					v && typeof v === "object"
						? v.answer != null
							? v.answer
							: v.value
						: v;
				if (ans == null) return;
				out.set(seq, { answer: normalizeAnswer(ans), confidence: null, reason: "", type: "" });
			});
			return out;
		}

		function normalizeAnswer(a) {
			if (a == null) return "";
			if (Array.isArray(a)) return a.map((x) => String(x).trim()).filter(Boolean);
			return String(a).trim();
		}

		/**
		 * 请求一批题目的答案。
		 * @returns {Promise<Map<number, {answer, confidence, reason}>>}
		 */
		async function solveBatch(items, cfg) {
			const messages = [
				{
					role: "system",
					content: [{ type: "text", text: cfg.systemPrompt || SYSTEM_PROMPT }],
				},
				buildUserMessage(items),
			];
			const kb = LLM.estimatePayloadKB(messages);
			Log.info(
				"请求模型作答：第 " +
					items[0].seq +
					"-" +
					items[items.length - 1].seq +
					" 题（" +
					items.length +
					" 题，约 " +
					kb +
					"KB）",
			);
			if (cfg.debugDump) {
				Log.info(
					"请求明细：" +
						JSON.stringify(
							{
								model: cfg.model,
								style: cfg.apiStyle,
								url: LLM.endpoint(cfg.baseUrl, cfg.apiStyle),
								items: items.map((i) => ({
									seq: i.seq,
									images: (i.images || []).length,
									textLen: (i.text || "").length,
								})),
							},
							null,
							0,
						),
				);
			}
			const res = await LLM.chat({ config: cfg, messages: messages });
			if (cfg.debugDump) Log.info("模型原始输出：" + String(res.text || "").slice(0, 800));
			const map = parseAnswers(res.text);
			if (!map.size) {
				Log.warn("模型输出无法解析为答案，原始内容：" + String(res.text || "").slice(0, 300));
			}
			return map;
		}

		return { solveBatch, parseAnswers, SYSTEM_PROMPT };
	})();

	// >>> 42-fill.js
	// ========================= 16. 答案填充（选项点选 / 填空写入） =========================

	const Fill = {
		/** 选项字母归一化（A/B/C…，容忍全角、带点、空格、小写） */
		normLetter(s) {
			return String(s || "")
				.replace(/[\s.、,，。;；:：]/g, "")
				.replace(/[Ａ-Ｚａ-ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
				.toUpperCase();
		},

		/** 把答案文本拆成选项字母数组 */
		splitLetters(answer) {
			const s = this.normLetter(answer);
			const letters = s.match(/[A-Z]/g);
			if (letters && letters.length) return Array.from(new Set(letters));
			// 数字型选项（1/2/3/4 作为 A/B/C/D 的替代写法）
			const digits = s.match(/[0-9]+/g);
			if (digits && digits.length) {
				return Array.from(
					new Set(
						digits
							.map((d) => parseInt(d, 10) - 1)
							.filter((n) => n >= 0 && n < 26)
							.map((n) => String.fromCharCode(65 + n)),
					),
				);
			}
			return [];
		},

		/** 判断某个选项当前是否处于选中态 */
		isChecked(opt) {
			const label = opt.li.querySelector(SEL.optionLabel);
			return !!(
				(label && label.classList.contains("check_answer")) ||
				opt.li.getAttribute("aria-checked") === "true" ||
				opt.li.classList.contains("check_answer")
			);
		},

		/** 点选单个选项（优先复用页面自身的 addChoice，保证内部状态同步） */
		clickOption(question, opt) {
			const win = question.doc && question.doc.defaultView;
			try {
				if (win && typeof win.addChoice === "function") {
					win.addChoice(opt.li);
					return true;
				}
			} catch (e) {
				/* 回退到原生点击 */
			}
			try {
				opt.li.click();
				return true;
			} catch (e2) {
				return false;
			}
		},

		/** 根据答案文本作答某道选择题 */
		async applyChoiceAnswer(question, answer) {
			const letters = this.splitLetters(answer);
			if (!letters.length) return { ok: false, reason: "无法解析选项字母" };
			const byLetter = new Map();
			question.options.forEach((o) => byLetter.set(this.normLetter(o.letter), o));

			const targets = letters.map((l) => byLetter.get(l)).filter(Boolean);
			if (!targets.length)
				return {
					ok: false,
					reason: "答案字母不在本题选项中（" + letters.join("") + "）",
				};

			const isMulti = question.typeKey === "多选题";
			// 单选/判断题：确保目标唯一选中
			if (!isMulti) {
				const target = targets[0];
				if (!this.isChecked(target)) {
					this.clickOption(question, target);
					await sleep(CFG.fillVerifyDelay);
				}
				// 取消其它误选项
				for (const opt of question.options) {
					if (opt === target) continue;
					if (this.isChecked(opt)) {
						this.clickOption(question, opt);
						await sleep(CFG.fillVerifyDelay);
					}
				}
				const ok = this.isChecked(target);
				return { ok, reason: ok ? "" : "点选未生效", picked: [target.letter] };
			}

			// 多选：先选目标，再清掉非目标
			for (const opt of targets) {
				if (!this.isChecked(opt)) {
					this.clickOption(question, opt);
					await sleep(CFG.fillVerifyDelay);
				}
			}
			for (const opt of question.options) {
				if (targets.indexOf(opt) !== -1) continue;
				if (this.isChecked(opt)) {
					this.clickOption(question, opt);
					await sleep(CFG.fillVerifyDelay);
				}
			}
			const picked = targets.filter((o) => this.isChecked(o)).map((o) => o.letter);
			return {
				ok: picked.length === targets.length,
				reason: picked.length === targets.length ? "" : "部分选项未生效",
				picked,
			};
		},

		/** 统一入口：按题型分派（仅支持单选 / 多选 / 判断） */
		async apply(question, answer) {
			if (!question.options || !question.options.length)
				return { ok: false, reason: "该题型不支持自动作答（仅支持单选/多选/判断）" };
			return this.applyChoiceAnswer(question, answer);
		},
	};

	// >>> 50-answer-task.js
	// ========================= 17. 答题任务点处理（编排：提取 → 渲染 → 提问 → 填充 → 提交） =========================

	const AnswerTask = (function () {
		/** 是否允许自动作答该题型（仅支持 单选 / 多选 / 判断） */
		function isTypeAllowed(typeKey, types) {
			const supported = SUPPORTED_TYPES.find((t) => String(typeKey).indexOf(t) !== -1);
			if (!supported) return false;
			const map = types && typeof types === "object" ? types : ANSWER_DEFAULTS.types;
			return map[supported] !== false;
		}

		/** 等待题目文档就绪，并把混淆字体注册到顶层文档供离屏渲染复现 */
		async function acquireDoc(job) {
			const doc = await Extract.waitForQuestions(job.iframe, CFG.workSettleTimeout);
			if (FontTools.hasSecretFont(doc)) {
				const ok = await FontTools.registerSecretFont(doc, document);
				if (ok) Log.info("检测到字体混淆，已捕获映射并用于位图还原");
				else Log.warn("混淆字体注册失败，位图还原可能不完整");
			}
			return doc;
		}

		/**
		 * 逐题作答：渲染 → 展示图片 → 请求模型 → 展示回答详情 → 点选 → 展示结果。
		 * 每题独立请求，日志严格按「题目图 → LLM 回答 → 点选结果」三段展示。
		 */
		async function solveOne(it, cfg, ansCfg, stat, jobKey) {
			const q = it.question;
			const seq = it.seq;
			const cardKey = "q:" + jobKey + ":" + seq;
			Log.use(cardKey, {
				kind: "q",
				title: "第 " + seq + " 题 · " + it.typeKey,
				badge: "作答中",
				badgeCls: "run",
			});

			// —— 第 1 段：题目渲染与展示 ——
			Panel.setTask("渲染第 " + seq + " 题图片");
			let rendered = null;
			try {
				rendered = await QuestionRenderer.render(q);
				it.images = rendered.images;
				it.renderFailed = false;
			} catch (e) {
				if (e === STOP) throw e;
				it.renderFailed = true;
				Log.error("渲染失败：" + e.message);
			}

			if (it.renderFailed || !it.images.length) {
				stat.blank++;
				Log.warn("已跳过该题（无法还原题目内容）");
				Log.meta(null, "跳过", "err");
				return;
			}

			Log.image(
				it.images[0],
				"发送给模型的题目图",
				"渲染方式：" +
					(rendered.method === "native" ? "页面原生栅格化" : "canvas 重绘") +
					(rendered.ciphers ? "，已还原 " + rendered.ciphers + " 个混淆字符" : ""),
			);

			// —— 第 2 段：请求模型并展示回答详情 ——
			Panel.setTask("模型作答：第 " + seq + " / " + stat.total + " 题");
			let a = null;
			try {
				const map = await AnswerProvider.solveBatch([it], cfg);
				a = map.get(seq) || null;
			} catch (e) {
				if (e === STOP) throw e;
				Log.error("请求失败：" + e.message);
				// 环境/配置类问题（如未在油猴环境运行导致混合内容被拦截）对所有题目都一样，继续跑没有意义
				if (e.fatal) {
					stat.status = "aborted";
					Log.meta(null, "已中止", "err");
					throw e;
				}
			}

			if (!a) {
				Log.llm("模型未返回可用答案");
				if (ansCfg.unknownAction === "guess" && q.options && q.options.length) {
					const pick = q.options[Math.floor(Math.random() * q.options.length)];
					Log.warn("按配置随机作答：" + pick.letter);
					a = { answer: pick.letter, confidence: null, reason: "模型无输出，随机选择" };
				} else {
					stat.blank++;
					Log.warn("留空不作答（可在配置中改为随机作答）");
					Log.meta(null, "留空", "err");
					return;
				}
			} else {
				const ansText = Array.isArray(a.answer) ? a.answer.join(" / ") : a.answer;
				Log.llm(
					"模型回答：" +
						ansText +
						(a.confidence != null ? "（置信度 " + a.confidence + "）" : ""),
				);
				if (a.reason) Log.llm("依据：" + a.reason);
			}

			// —— 第 3 段：点选并展示结果 ——
			Panel.setTask("填写作答：第 " + seq + " / " + stat.total + " 题");
			const r = await Fill.apply(q, a.answer);
			if (r.ok) {
				stat.filled++;
				const picked = (r.picked && r.picked.length ? r.picked : [a.answer]).join("");
				Log.pick("已点选：" + picked);
				Log.meta(null, picked, "ok");
			} else {
				stat.failed++;
				Log.error("点选失败：" + (r.reason || "未知原因"));
				Log.meta(null, "失败", "err");
			}
		}

		/**
		 * 答题任务点主流程。
		 * 注意：本流程**不会自动提交**，作答完成后仅点击「暂时保存」，
		 *       最终提交必须由用户在学习通页面上手动点击「提交」。
		 * @returns {Promise<{status:'done'|'skipped'|'failed', total:number, filled:number, failed:number, blank:number, saved:boolean}>}
		 */
		async function run(job, ansCfg, cardKey) {
			const cfg = store.config("llm", LLM_DEFAULTS);
			if (!ansCfg.enabled) {
				Log.skip("跳过答题任务点「" + job.title + "」（自动答题已关闭）");
				return { status: "skipped", total: 0, filled: 0, failed: 0, blank: 0, saved: false };
			}
			if (!cfg.apiKey || !cfg.model) {
				throw new Error(
					"LLM 未配置：请点击面板中的「配置 LLM…」填写 Base URL、API Key 与多模态模型名",
				);
			}

			// A. 定位题目文档
			const doc = await acquireDoc(job);

			// 答题任务点：默认独立建卡；由主流程传入课时卡片时并入课时日志
			const jobKey = cardKey || "job:" + (job.jobid || job.title);
			if (cardKey) Log.use(jobKey);
			else
				Log.use(jobKey, {
					kind: "job",
					title: "答题任务点 · " + job.title,
					badge: "分析中",
					badgeCls: "run",
				});

			// B. 解析题目
			const all = Extract.parseAll(doc);
			if (!all.length) throw new Error("未在答题页面中解析到任何题目");
			Log.info("共 " + all.length + " 道题，开始逐题作答");

			// C. 过滤需要作答的题目
			const pending = [];
			let skippedFilled = 0,
				skippedType = 0;
			for (const q of all) {
				const hasAnswerChannel = q.options && q.options.length;
				if (!hasAnswerChannel) {
					skippedType++;
					continue;
				}
				if (ansCfg.skipFilled && q.answered) {
					skippedFilled++;
					continue;
				}
				if (!isTypeAllowed(q.typeKey, ansCfg.types)) {
					skippedType++;
					continue;
				}
				pending.push(q);
			}
			if (skippedFilled) Log.info("跳过已作答题目 " + skippedFilled + " 道");
			if (skippedType)
				Log.skip(
					"跳过不支持的题目 " +
						skippedType +
						" 道（仅支持 " +
						SUPPORTED_TYPES.join(" / ") +
						"，且需在面板中勾选）",
				);

			const stat = {
				status: "done",
				total: all.length,
				filled: 0,
				failed: 0,
				blank: 0,
				saved: false,
			};

			// D. 逐题作答（题目文字被字体混淆，一律以位图交给多模态模型识别）
			Panel.setStatus("运行中");
			for (let i = 0; i < pending.length; i++) {
				if (S.stopRequested) throw STOP;
				const q = pending[i];
				const it = {
					seq: q.seq,
					typeKey: q.typeKey,
					options: q.options,
					images: [],
					question: q,
				};
				Log.use(jobKey);
				Log.meta(null, i + 1 + " / " + pending.length, "run");
				try {
					await solveOne(it, cfg, ansCfg, stat, jobKey);
				} catch (e) {
					if (e === STOP) throw e;
					stat.failed++;
					Log.use(jobKey);
					Log.error("第 " + q.seq + " 题处理异常：" + ((e && e.message) || e));
				}
			}

			// E. 暂存（不提交）
			Log.use(jobKey);
			if (ansCfg.autoTempSave && stat.filled > 0) {
				Panel.setTask("暂存答案");
				await sleep(400);
				const res = await tempSaveWork(doc);
				if (res.ok) {
					stat.saved = true;
					Log.ok("答案已暂存：" + res.reason);
				} else {
					Log.error("答案暂存失败：" + res.reason);
					stat.status = "failed";
				}
			} else if (stat.filled > 0) {
				Log.info("已按配置跳过自动暂存，答案已填入页面（请手动暂存或提交）");
			}

			Log.info(
				"处理结束：成功 " +
					stat.filled +
					" 题" +
					(stat.failed ? "，失败 " + stat.failed + " 题" : "") +
					(stat.blank ? "，留空 " + stat.blank + " 题" : "") +
					"，跳过 " +
					(skippedFilled + skippedType) +
					" 题",
			);
			Log.warn("⚠ 请在学习通页面上人工复核答案后，手动点击「提交」完成任务点");
			Log.meta(
				null,
				stat.status === "failed" ? "暂存失败" : stat.saved ? "已暂存" : "已作答",
				stat.status === "failed" ? "err" : "ok",
			);
			return stat;
		}

		/**
		 * 点击「暂时保存」暂存答案（提交始终由用户手动完成）。
		 * 实测：a.btnSave[onclick=noSubmit()] → POST /mooc-ans/work/addStudentWorkNew
		 *       响应 {"msg":"保存成功！","status":true}；成功后再点击会直接 return（tempSave 已置位）。
		 */
		async function tempSaveWork(doc) {
			const btn = doc.querySelector(SEL.saveBtn);
			if (!btn) return { ok: false, reason: "未找到「暂时保存」按钮" };
			if (!Dom.isVisible(btn)) return { ok: false, reason: "「暂时保存」按钮不可见" };

			const win = doc.defaultView;
			const before = typeof win.tempSave !== "undefined" ? win.tempSave : null;

			// 挂钩 XHR 以捕获真实回执
			let captured = null;
			let hooked = null;
			try {
				if (win.XMLHttpRequest) {
					const proto = win.XMLHttpRequest.prototype;
					const oOpen = proto.open,
						oSend = proto.send;
					const patch = () => {
						proto.open = function (m, u) {
							try {
								this.__cxapSaveUrl = String(u || "");
							} catch (e) {
								/* noop */
							}
							return oOpen.apply(this, arguments);
						};
						proto.send = function () {
							if (
								this.__cxapSaveUrl &&
								/addStudentWorkNew|tempSave|saveWork/i.test(this.__cxapSaveUrl)
							) {
								this.addEventListener("load", function () {
									try {
										const body = String(this.responseText || "");
										const j = safeParse(body, null);
										if (j && (j.status === true || j.status === "true"))
											captured = j.msg || "保存成功";
										else if (j && j.msg) captured = "失败：" + j.msg;
									} catch (e) {
										/* noop */
									}
								});
							}
							return oSend.apply(this, arguments);
						};
					};
					patch();
					hooked = () => {
						proto.open = oOpen;
						proto.send = oSend;
					};
				}
			} catch (e) {
				/* 挂钩失败仍有按钮文案兜底 */
			}

			Log.info("点击「暂时保存」暂存答案");
			try {
				btn.click();
			} catch (e) {
				if (hooked) hooked();
				return { ok: false, reason: "点击失败：" + e.message };
			}

			let ok = false;
			let reason = "";
			const start = Date.now();
			while (Date.now() - start < CFG.tempSaveTimeout) {
				if (S.stopRequested) {
					if (hooked) hooked();
					throw STOP;
				}
				await sleep(400);
				if (captured) {
					ok = !/^失败/.test(captured);
					reason = captured;
					break;
				}
				// 页面自身也会把按钮文案改成「暂存成功」之类
				const txt = Dom.normText(btn.textContent);
				if (/成功|已保存|已暂存/.test(txt)) {
					ok = true;
					reason = txt;
					break;
				}
				try {
					const after = typeof win.tempSave !== "undefined" ? win.tempSave : null;
					if (before === false && after === true) {
						ok = true;
						reason = reason || "页面已置为已暂存状态";
						break;
					}
				} catch (e) {
					/* noop */
				}
			}
			if (hooked) hooked();
			if (!ok && !reason) reason = "未捕获到暂存回执";
			return { ok, reason };
		}

		return { run, tempSaveWork, isTypeAllowed, solveOne, acquireDoc };
	})();

	// >>> 60-runner.js
	// ========================= 18. 主流程（Runner 状态机） =========================

	function refreshCatalog() {
		S.lessons = scanLessons();
		if (S.lessonIdx >= 0) {
			const idx = S.lessons.findIndex((l) => l.kid === (S.lessons[S.lessonIdx] || {}).kid);
			if (idx >= 0) S.lessonIdx = idx;
		}
	}

	/** 单个视频任务点：有限重试 → 仍失败则记 ERROR 跳过（不中断整体）；返回是否完成 */
	async function processVideoWithRetry(job, cardKey) {
		let lastErr = null;
		for (let attempt = 1; attempt <= CFG.maxJobRetries; attempt++) {
			if (S.stopRequested) throw STOP;
			try {
				Log.use(cardKey);
				Panel.setStatus("运行中");
				Panel.setTask("分析视频：" + job.title);
				const via = await handleVideoTask(job, cardKey);
				S.videoDone++;
				Panel.setTask("当前视频任务点完成");
				Log.use(cardKey);
				Log.ok(
					"已完成（判定依据：" +
						(via === "taskpoint" ? "学习通任务点状态" : "视频播放结束") +
						"）",
				);
				return true;
			} catch (e) {
				if (e === STOP) throw e;
				lastErr = e;
				Log.use(cardKey);
				Log.error(
					"处理异常（第 " + attempt + "/" + CFG.maxJobRetries + " 次）：" + e.message,
				);
				if (attempt < CFG.maxJobRetries) {
					Panel.setStatus("等待中");
					Panel.setTask("等待重试");
					await sleep(3000);
				}
			}
		}
		Log.use(cardKey);
		Panel.setStatus("异常");
		Log.error("重试后仍未完成，跳过并继续后续任务（" + (lastErr && lastErr.message) + "）");
		await sleep(1500); // 给用户看清日志
		return false;
	}

	/** 单个答题任务点：有限重试 → 仍失败则记 ERROR 跳过；返回是否完成 */
	async function processAnswerWithRetry(job, cardKey) {
		const ansCfg = store.config("answer", ANSWER_DEFAULTS);
		const jobKey = cardKey || "job:" + (job.jobid || job.title);
		let lastErr = null;
		for (let attempt = 1; attempt <= CFG.maxJobRetries; attempt++) {
			if (S.stopRequested) throw STOP;
			try {
				Log.use(jobKey);
				Panel.setStatus("运行中");
				Panel.setTask("分析答题：" + job.title);
				const stat = await AnswerTask.run(job, ansCfg, cardKey);
				if (stat.status === "skipped") return true;
				if (stat.status === "aborted") {
					// 环境/配置类问题：重试无意义，直接抛出以停止整个任务
					throw new Error("模型请求环境不可用，已中止答题（详见日志）");
				}
				if (stat.status === "failed") {
					lastErr = new Error(stat.saved ? "暂存未成功" : "答题未完成");
					throw lastErr;
				}
				S.answerDone++;
				Panel.setTask("当前答题任务点完成");
				return true;
			} catch (e) {
				if (e === STOP) throw e;
				lastErr = e;
				Log.use(jobKey);
				Log.error(
					"处理异常（第 " + attempt + "/" + CFG.maxJobRetries + " 次）：" + ((e && e.message) || e),
				);
				if (attempt < CFG.maxJobRetries) {
					Panel.setStatus("等待中");
					Panel.setTask("等待重试");
					await sleep(3000);
				}
			}
		}
		Log.use(jobKey);
		Panel.setStatus("异常");
		Log.error("重试后仍未完成，跳过并继续后续任务（" + (lastErr && lastErr.message) + "）");
		await sleep(1500);
		return false;
	}

	async function run() {
		S.stopRequested = false;
		S.videoSeen = 0;
		S.videoDone = 0;
		S.answerSeen = 0;
		S.answerDone = 0;
		S.lessonIdx = -1;
		Panel.setTask("准备中");
		// 新一轮运行：清空上一轮的日志卡片与导航方式缓存
		Panel.clearCards();
		resetNavMode();
		Log.useSystem();

		const ansCfg = store.config("answer", ANSWER_DEFAULTS);
		const llmCfg = store.config("llm", LLM_DEFAULTS);
		const llmReady = !!(llmCfg.apiKey && llmCfg.model);
		const answerEnabled = !!ansCfg.enabled && llmReady;
		if (ansCfg.enabled && !llmReady) {
			Log.warn("自动答题已开启但 LLM 未配置，本次将直接跳过答题任务点（请在「高级设置」中配置）");
		}
		// 运行期间关闭站点自身的自动连播，避免与脚本切课竞争导致页面跳转/重载
		disableSiteAutoNext();

		// ---- SCANNING：扫描课程目录 ----
		Panel.setStatus("运行中");
		Log.info("开始扫描课程目录");
		S.lessons = scanLessons();
		if (!S.lessons.length) throw new Error("未找到课程目录/课时列表，页面结构可能已变化");
		Log.info("找到 " + S.lessons.length + " 个课时");

		// 定位当前课时
		let idx = S.lessons.findIndex((l) => l.isCurrent);
		if (idx < 0) idx = S.lessons.findIndex((l) => l.kid === courseParams().chapterId);
		if (idx < 0) {
			idx = 0;
			Log.warn("未识别当前课时，从第一个课时开始");
		}

		let skippedLessons = 0;

		// ---- 逐课时处理（每个课时一张独立卡片） ----
		for (let i = idx; i < S.lessons.length; i++) {
			if (S.stopRequested) throw STOP;
			const lesson = S.lessons[i];
			S.lessonIdx = i;
			Panel.setLesson(i + 1 + " / " + S.lessons.length + "　" + lesson.title);

			// 整课时已无未完成任务点（渲染快照）→ 快速跳过，不建卡片避免日志刷屏
			if (lesson.unfinished === 0) {
				skippedLessons++;
				continue;
			}

			const lessonKey = "lesson:" + lesson.kid;
			let lessonKind = ""; // video | answer | mixed
			let lessonHadError = false;
			let lessonJobCount = 0;

			const markLessonKind = (kind) => {
				const next = !lessonKind ? kind : lessonKind === kind ? kind : "mixed";
				if (next === lessonKind) return;
				lessonKind = next;
				Log.use(lessonKey);
				if (next === "mixed") Log.meta("课时任务", undefined, undefined, "sys");
				else if (next === "video") Log.meta("视频任务", undefined, undefined, "video");
				else Log.meta("答题任务", undefined, undefined, "job");
			};

			Log.use(lessonKey, {
				kind: "video",
				title: "课时任务",
				badge: "进行中",
				badgeCls: "run",
			});
			Log.info("进入：" + lesson.title + "（" + (i + 1) + "/" + S.lessons.length + "）");

			// 页面不在该课时 → 切换
			const active = document.querySelector("." + SEL.currentLessonActive);
			const onLesson =
				(active && active.id === "cur" + lesson.kid) ||
				(cardsIframeEl() && (cardsIframeEl().src || "").indexOf("knowledgeid=" + lesson.kid) !== -1);
			if (!onLesson) {
				await gotoLesson(lesson);
				Log.use(lessonKey); // 导航方式首次确定时会写入系统卡片
			}

			// 该课时包含的所有卡片依次处理
			const tabCount = document.querySelectorAll(SEL.cardTabs).length;
			const total = Math.max(tabCount, 1);

			for (let n = 1; n <= total; n++) {
				if (S.stopRequested) throw STOP;
				Log.use(lessonKey);
				if (n > 1) await switchCard(n, total, lesson);
				const doc = await waitForCardsReady(lesson.kid, n - 1);
				Log.use(lessonKey);

				// ---- ANALYZE_TASKS ----
				const jobs = scanCardJobs(doc);
				if (!jobs.length) {
					Log.info("卡片 " + n + " 无任务点");
					continue;
				}

				// ---- 按 DOM 顺序处理本卡片内的任务点 ----
				for (const job of jobs) {
					if (S.stopRequested) throw STOP;
					if (job.type === "video") {
						S.videoSeen++;
						markLessonKind("video");
						if (job.done) {
							S.videoDone++;
							Log.use(lessonKey);
							Log.info("视频任务点已完成，跳过：" + job.title);
							continue;
						}
						lessonJobCount++;
						if (!(await processVideoWithRetry(job, lessonKey))) lessonHadError = true;
					} else if (job.type === "answer") {
						S.answerSeen++;
						markLessonKind("answer");
						if (job.done) {
							S.answerDone++;
							Log.use(lessonKey);
							Log.info("答题任务点已完成，跳过：" + job.title);
							continue;
						}
						if (!answerEnabled) {
							Log.use(lessonKey);
							Log.skip(
								"跳过答题任务点「" +
									job.title +
									"」（" +
									(!ansCfg.enabled ? "自动答题已关闭" : "LLM 未配置") +
									"）",
							);
							continue;
						}
						lessonJobCount++;
						if (!(await processAnswerWithRetry(job, lessonKey))) lessonHadError = true;
					} else {
						Log.use(lessonKey);
						Log.skip("跳过其他任务点「" + job.title + "」（类型：" + job.type + "）");
					}
				}
			}

			Log.use(lessonKey);
			if (!lessonJobCount) Log.skip("当前课时不包含待处理的任务点，跳过");
			Log.info("课时处理完成，准备进入下一个课时");
			Log.meta(
				null,
				lessonHadError ? "有异常" : lessonJobCount ? "已完成" : "已跳过",
				lessonHadError ? "err" : lessonJobCount ? "ok" : "",
			);
		}

		// ---- FINISHED ----
		restoreSiteAutoNext();
		// 正常跑完：清除续跑标记，避免下次打开学习页又自动开始
		store.set("running", false);
		Panel.setStatus("已完成");
		Panel.setTask("全部完成");
		Log.useSystem();
		if (skippedLessons) Log.skip("跳过 " + skippedLessons + " 个已全部完成的课时");
		Log.info(
			"课程处理完毕：视频任务点 " +
				S.videoDone +
				"/" +
				S.videoSeen +
				"，答题任务点 " +
				S.answerDone +
				"/" +
				S.answerSeen,
		);
		if (S.answerDone > 0) Log.warn("提醒：答题内容仅已暂存，请在各答题页面手动点击「提交」完成任务点");
	}

	const Runner = {
		start() {
			if (S.running) return;
			S.running = true;
			// 记忆运行状态：刷新 / 重进学习页后自动续跑
			store.set("running", true);
			run()
				.catch((e) => {
					if (e === STOP || S.stopRequested) {
						Log.info("已停止刷课");
						Panel.setStatus("已停止");
					} else {
						Log.error("流程异常终止：" + ((e && e.message) || e));
						Panel.setStatus("异常");
					}
				})
				.then(() => {
					S.running = false;
					restoreSiteAutoNext();
				});
		},
		stop() {
			S.stopRequested = true;
			// 清除运行状态记忆，避免下次进入页面又自动开启
			store.set("running", false);
			// 立即终结所有挂起等待
			S.pending.forEach((item) => {
				if (item.timer) clearTimeout(item.timer);
				try {
					item.reject(STOP);
				} catch (e) {
					/* noop */
				}
			});
			S.pending.clear();
			// 断开所有观察器
			S.observers.forEach((o) => {
				try {
					o.disconnect();
				} catch (e) {
					/* noop */
				}
			});
			S.observers = [];
			// 停止后不再让视频继续在后台播放，并恢复站点自动连播设置
			pauseCourseVideos();
			restoreSiteAutoNext();
			// 清理离屏渲染容器中的残留节点（面板保留）
			const rh = document.getElementById("cxap-render-host");
			if (rh) rh.innerHTML = "";
			Panel.setStatus("已停止");
			Panel.setTask("—");
			Log.info("用户停止刷课：已终止定时器与监听，不再自动切换课时");
		},
		/** 是否处于「记忆的运行中」状态（用于页面重新加载后续跑） */
		wasRunning() {
			return !!store.get("running", false);
		},
	};

	// >>> 99-main.js
	// ========================= 19. 启动 =========================

	function main() {
		Panel.ensure();
		const ver = (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || "0.4.0";
		Log.useSystem();
		Log.info("脚本已加载（v" + ver + "）｜点击「开始刷课」启动");
		const llmCfg = store.config("llm", LLM_DEFAULTS);
		if (llmCfg.apiKey && llmCfg.model) {
			Log.info("自动答题已就绪（模型：" + llmCfg.model + "）");
		} else {
			Log.warn("自动答题未配置：点击面板左上角的齿轮按钮打开「高级设置」，填写 Base URL / API Key / 多模态模型");
		}
		// 请求环境自检：无 GM 时无法绕过 CORS / 混合内容，提前明确告知，避免答题时才失败
		if (!LLM.hasGM()) {
			const pf = LLM.preflight(LLM.endpoint(llmCfg.baseUrl, llmCfg.apiStyle));
			Log.error(
				"当前未运行在油猴环境中（GM_xmlhttpRequest 不可用），模型请求将受浏览器同源策略限制。" +
					"请通过 Tampermonkey 安装并启用本脚本。",
			);
			if (!pf.ok) Log.error(pf.reason);
		}
		const lessons = scanLessons();
		const cur = lessons.find((l) => l.isCurrent);
		Panel.setLesson(
			cur ? lessons.indexOf(cur) + 1 + " / " + lessons.length + "　" + cur.title : "—",
		);
		// 记忆的运行状态：上次未停止则自动续跑（点击「停止」会清除该状态）
		if (Runner.wasRunning()) {
			Log.info("检测到刷课处于运行状态，3 秒后自动续跑（点「停止」可取消）");
			Panel.setStatus("等待中");
			Panel.setTask("准备续跑");
			setTimeout(() => {
				if (!S.running && !S.stopRequested) Runner.start();
			}, 3000);
		}
		// 调试接口：便于在浏览器控制台定位问题与二次开发（对所有页面脚本可见，仅提供只读引用）
		try {
			window.__CXAP__ = {
				Extract,
				QuestionRenderer,
				Fill,
				AnswerTask,
				AnswerProvider,
				LLM,
				FontTools,
				Dom,
				store,
				S,
				Runner,
				ConfigUI,
				Panel,
				Log,
				CFG,
				LLM_DEFAULTS,
				ANSWER_DEFAULTS,
				VIDEO_DEFAULTS,
				scanCardJobs,
				scanLessons,
				gotoLesson,
				softNavigateLesson,
				pauseCourseVideos,
				Video: {
					getVideoPlayer,
					readRateOptions,
					createSpeedController,
					handleVideoTask,
				},
			};
		} catch (e) {
			/* noop */
		}
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", main);
	} else {
		main();
	}
})();
