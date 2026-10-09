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
		maxPauseResumes: 500, // 单任务点恢复播放的绝对上限（兜底；实际由进度看门狗主导）
		noProgressTimeout: 180000, // 视频 currentTime 持续无推进的最长容忍时间（超时判失败）
		maxJobRetries: 2, // 单个任务点重试次数上限
		monitorInterval: 1000, // 监控轮询间隔（兜底，事件驱动为主）
		progressLogInterval: 30000, // 播放进度日志输出间隔
		logMaxCards: 220, // 日志区保留的最大卡片数（超出后淘汰最早的卡片）
		// 说明：一次完整运行会为每个视频/作业任务点、每道题各建一张卡片，
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
		meta(title, badge, badgeCls) {
			Panel.cardMeta(this._cur, { title, badge, badgeCls });
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
	// ========================= 7. 悬浮控制面板（Shadow DOM 隔离） =========================

	const Panel = (function () {
		let host = null,
			root = null,
			el = {};

		const HTML = `
	      <style>
	        :host { all: initial; }
	        * { box-sizing: border-box; margin: 0; padding: 0;
	            font-family: "Microsoft YaHei", "PingFang SC", -apple-system, sans-serif; }
	        .panel { width: 620px; background: #fff; border-radius: 14px; overflow: hidden;
	                 box-shadow: 0 10px 34px rgba(15,23,42,.22), 0 2px 8px rgba(15,23,42,.08);
	                 font-size: 11.5px; color: #0f172a; position: relative; }

	        /* 标题栏 */
	        .titlebar { background: linear-gradient(120deg, #4f46e5, #6366f1 55%, #818cf8);
	                    color: #fff; padding: 10px 13px; display: flex; align-items: center;
	                    gap: 9px; cursor: move; user-select: none; }
	        .titlebar .brand { width: 8px; height: 8px; border-radius: 50%; background: #a5b4fc;
	                           box-shadow: 0 0 0 3px rgba(255,255,255,.22); flex: 0 0 auto; }
	        .titlebar .t { font-weight: 650; font-size: 12.5px; letter-spacing: .3px; flex: 1; }
	        .titlebar .ibtn { width: 22px; height: 22px; border-radius: 6px; display: flex;
	                          align-items: center; justify-content: center; cursor: pointer;
	                          font-size: 13px; line-height: 1; opacity: .9; transition: all .15s; }
	        .titlebar .ibtn:hover { background: rgba(255,255,255,.2); opacity: 1; }

	        /* 两栏布局：左控制区 + 右日志区 */
	        .body { display: flex; align-items: stretch; height: 402px; }
	        .col-left { width: 298px; flex: 0 0 auto; padding: 11px 12px 12px;
	                    display: flex; flex-direction: column; border-right: 1px solid #eef2f7; }
	        .col-right { flex: 1 1 auto; min-width: 0; padding: 11px 12px 12px;
	                     display: flex; flex-direction: column; }

	        /* 状态区 */
	        .statline { display: flex; align-items: center; gap: 7px; margin-bottom: 2px; }
	        .pill { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px;
	                border-radius: 999px; font-size: 10.5px; font-weight: 650; flex: 0 0 auto; }
	        .pill i { width: 6px; height: 6px; border-radius: 50%; background: currentColor;
	                  display: block; }
	        .p-idle { background: #f1f5f9; color: #64748b; }
	        .p-run { background: #ecfdf5; color: #047857; }
	        .p-wait { background: #fffbeb; color: #b45309; }
	        .p-err { background: #fef2f2; color: #dc2626; }
	        .p-done { background: #eef2ff; color: #4338ca; }
	        .p-run i { animation: pulse 1.5s ease-in-out infinite; }
	        @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .3 } }
	        .curtask { flex: 1; text-align: right; color: #94a3b8; font-size: 11px; overflow: hidden;
	                   text-overflow: ellipsis; white-space: nowrap; }

	        /* 进度 */
	        .prog { margin-top: 7px; }
	        .prow { display: flex; align-items: center; gap: 7px; margin: 5px 0; }
	        .prow .lbl { color: #64748b; font-size: 11px; width: 62px; flex: 0 0 auto; }
	        .bar { flex: 1; height: 4px; border-radius: 999px; background: #eef2f7; overflow: hidden; }
	        .bar span { display: block; height: 100%; width: 0%; border-radius: 999px;
	                    transition: width .3s ease; }
	        .bar.v span { background: linear-gradient(90deg, #34d399, #10b981); }
	        .bar.a span { background: linear-gradient(90deg, #818cf8, #6366f1); }
	        .cnt { font-variant-numeric: tabular-nums; color: #475569; font-weight: 650;
	               font-size: 10.5px; width: 46px; text-align: right; flex: 0 0 auto; }
	        .lesson { margin-top: 6px; color: #94a3b8; font-size: 10.5px; overflow: hidden;
	                  text-overflow: ellipsis; white-space: nowrap; }

	        /* 主按钮 */
	        .mainbtn { width: 100%; margin-top: 9px; padding: 8px 0; border: 0; border-radius: 9px;
	                   cursor: pointer; font-size: 12.5px; font-weight: 650; color: #fff;
	                   letter-spacing: .3px; transition: all .18s; }
	        .mainbtn.start { background: linear-gradient(120deg, #4f46e5, #6366f1);
	                         box-shadow: 0 4px 14px rgba(79,70,229,.32); }
	        .mainbtn.start:hover { filter: brightness(1.06); }
	        .mainbtn.stop { background: linear-gradient(120deg, #ef4444, #f87171);
	                        box-shadow: 0 4px 14px rgba(239,68,68,.3); }
	        .mainbtn.stop:hover { filter: brightness(1.06); }

	        /* 设置区 */
	        .sect { display: flex; align-items: center; gap: 6px;
	                margin: 10px 0 6px; }
	        .sect .st { font-weight: 650; color: #334155; font-size: 11.5px;
	                    display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
	        .sect .st::before { content: ""; width: 3px; height: 11px; border-radius: 2px;
	                            background: #4f46e5; }
	        .sect .lnk { color: #4f46e5; cursor: pointer; font-size: 11px; font-weight: 600;
	                     flex: 0 0 auto; }
	        .sect .lnk:hover { text-decoration: underline; }
	        .sect .llmname { flex: 1 1 auto; min-width: 0; overflow: hidden;
	                         text-overflow: ellipsis; white-space: nowrap;
	                         color: #94a3b8; font-size: 11px; text-align: right; }
	        .sect .spacer { flex: 1 1 auto; }
	        .tag { display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 10px;
	               line-height: 15px; background: #eef2ff; color: #4338ca; font-weight: 600; }
	        .tag.warn { background: #fef2f2; color: #dc2626; }

	        /* 开关 */
	        .switches { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 10px; }
	        .sw { display: flex; align-items: center; justify-content: space-between; gap: 7px;
	              cursor: pointer; user-select: none; color: #475569; font-size: 11px;
	              padding: 1px 0; }
	        .sw input { position: absolute; opacity: 0; pointer-events: none; }
	        .sw .track { width: 29px; height: 16px; border-radius: 999px; background: #e2e8f0;
	                     flex: 0 0 auto; position: relative; transition: background .2s; }
	        .sw .track::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px;
	                            height: 12px; border-radius: 50%; background: #fff;
	                            box-shadow: 0 1px 3px rgba(15,23,42,.28); transition: transform .2s; }
	        .sw input:checked + .track { background: #4f46e5; }
	        .sw input:checked + .track::after { transform: translateX(13px); }
	        .sw:hover .track { filter: brightness(.97); }

	        /* 题型 chip */
	        .chips { display: flex; gap: 6px; flex-wrap: wrap; }
	        .chip { padding: 3px 10px; border-radius: 999px; border: 1px solid #e2e8f0;
	                background: #f8fafc; color: #64748b; font-size: 11px; cursor: pointer;
	                user-select: none; transition: all .15s; font-weight: 500; }
	        .chip:hover { border-color: #c7d2fe; color: #4f46e5; }
	        .chip.on { background: #4f46e5; border-color: #4f46e5; color: #fff;
	                   box-shadow: 0 2px 8px rgba(79,70,229,.28); font-weight: 600; }
	        .chip.dim { opacity: .45; cursor: not-allowed; }

	        /* 日志（卡片流） */
	        .loghd { display: flex; align-items: center; justify-content: space-between;
	                 margin-bottom: 6px; flex: 0 0 auto; }
	        .loghd .st { font-weight: 650; color: #334155; font-size: 11px;
	                     display: flex; align-items: center; gap: 6px; }
	        .loghd .st::before { content: ""; width: 3px; height: 11px; border-radius: 2px;
	                             background: #4f46e5; }
	        .loghd .cnt { color: #94a3b8; font-size: 10px; }

	        .log { flex: 1 1 auto; min-height: 0; overflow-y: auto; background: #f8fafc;
	               border: 1px solid #eef2f7; border-radius: 9px; padding: 8px;
	               display: flex; flex-direction: column; gap: 7px; }
	        .log::-webkit-scrollbar { width: 6px; }
	        .log::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
	        .log::-webkit-scrollbar-track { background: transparent; }

	        /* 卡片 */
	        .card { background: #fff; border: 1px solid #e8edf5; border-radius: 8px;
	                overflow: hidden; flex: 0 0 auto; }
	        .card.sys { background: #fbfcfe; border-color: #eef2f7; }
	        .card .chd { display: flex; align-items: center; gap: 6px; padding: 5px 8px;
	                     border-bottom: 1px solid #f1f5f9; }
	        .card.sys .chd { border-bottom-color: #eef2f7; }
	        .card .chd .bar { width: 3px; height: 11px; border-radius: 2px; flex: 0 0 auto; }
	        .card.sys .chd .bar { background: #94a3b8; }
	        .card.video .chd .bar { background: #10b981; }
	        .card.job .chd .bar { background: #6366f1; }
	        .card.q .chd .bar { background: #8b5cf6; }
	        .card .chd .ctitle { font-weight: 650; color: #334155; font-size: 10.5px;
	                             flex: 1 1 auto; min-width: 0; overflow: hidden;
	                             text-overflow: ellipsis; white-space: nowrap; }
	        .card .chd .cbadge { font-size: 9.5px; font-weight: 650; padding: 1px 6px;
	                             border-radius: 999px; background: #f1f5f9; color: #64748b;
	                             flex: 0 0 auto; }
	        .card .chd .cbadge.ok { background: #ecfdf5; color: #047857; }
	        .card .chd .cbadge.err { background: #fef2f2; color: #dc2626; }
	        .card .chd .cbadge.run { background: #eef2ff; color: #4338ca; }
	        .card .cbody { padding: 6px 8px 7px; }
	        .card .cbody:empty { display: none; }

	        .cline { display: flex; gap: 6px; line-height: 1.5; font-size: 10.5px;
	                 font-family: "Cascadia Mono", Consolas, monospace;
	                 word-break: break-all; }
	        .cline .ts { color: #b6c2d2; flex: 0 0 auto; font-size: 9.5px; padding-top: 1px; }
	        .cline .tx { flex: 1 1 auto; min-width: 0; white-space: pre-wrap; color: #64748b; }
	        .cline.INFO .tx { color: #15803d; }
	        .cline.SKIP .tx { color: #2563eb; }
	        .cline.WARN .tx { color: #b45309; }
	        .cline.ERROR .tx { color: #dc2626; }
	        .cline.OK .tx { color: #0f766e; font-weight: 600; }
	        .cline.LLM .tx { color: #7c3aed; }
	        .cline.PICK .tx { color: #0e7490; }

	        /* 题目缩略图（点击弹出查看） */
	        .thumb { display: flex; gap: 7px; align-items: center; margin-bottom: 5px;
	                 padding: 5px; background: #f8fafc; border: 1px dashed #dbe3ee;
	                 border-radius: 6px; cursor: pointer; transition: all .15s; }
	        .thumb:hover { background: #eef2ff; border-color: #c7d2fe; }
	        .thumb img { width: 74px; height: 40px; object-fit: cover; object-position: top left;
	                     border-radius: 4px; border: 1px solid #e2e8f0; background: #fff;
	                     flex: 0 0 auto; }
	        .thumb .tt { flex: 1 1 auto; min-width: 0; color: #4f46e5; font-size: 10.5px;
	                     font-weight: 600; line-height: 1.4; }
	        .thumb .tt small { display: block; color: #94a3b8; font-weight: 400;
	                           font-size: 9.5px; margin-top: 1px; }

	        /* 图片查看弹窗 */
	        .imgmask { position: absolute; inset: 0; background: rgba(15,23,42,.72);
	                   display: flex; align-items: center; justify-content: center;
	                   z-index: 100; padding: 18px; }
	        .imgmask .box { background: #fff; border-radius: 10px; overflow: hidden;
	                        max-width: 100%; max-height: 100%; display: flex;
	                        flex-direction: column; box-shadow: 0 18px 48px rgba(0,0,0,.4); }
	        .imgmask .bh { display: flex; align-items: center; gap: 8px; padding: 7px 10px;
	                       border-bottom: 1px solid #eef2f7; }
	        .imgmask .bh .bt { font-weight: 650; color: #334155; font-size: 11px;
	                           flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis;
	                           white-space: nowrap; }
	        .imgmask .bh .bx { cursor: pointer; color: #94a3b8; font-size: 16px; line-height: 1;
	                           padding: 0 3px; border-radius: 5px; }
	        .imgmask .bh .bx:hover { background: #fef2f2; color: #dc2626; }
	        .imgmask .bb { overflow: auto; padding: 8px; background: #fff; }
	        .imgmask .bb img { display: block; width: 100%; background: #fff; }
	      </style>
	      <div class="panel">
	        <div class="titlebar" id="titlebar">
	          <span class="brand"></span>
	          <span class="t">学习通任务点助手</span>
	          <span class="ibtn" id="btnmin" title="折叠">—</span>
	        </div>
	        <div class="body" id="body">
	          <div class="col-left">
	            <div class="statline">
	              <span class="pill p-idle" id="vstatus"><i></i>未启动</span>
	              <span class="curtask" id="vcur">—</span>
	            </div>
	            <div class="prog">
	              <div class="prow">
	                <span class="lbl">视频任务点</span>
	                <span class="bar v"><span id="barv"></span></span>
	                <span class="cnt" id="vtask">0 / 0</span>
	              </div>
	              <div class="prow">
	                <span class="lbl">答题任务点</span>
	                <span class="bar a"><span id="bara"></span></span>
	                <span class="cnt" id="vanswer">0 / 0</span>
	              </div>
	              <div class="lesson" id="vlesson">—</div>
	            </div>
	            <button class="mainbtn start" id="btnstart">开始刷课</button>

	            <div class="sect"><span class="st">运行设置</span></div>
	            <div class="switches">
	              <label class="sw">静音播放<input type="checkbox" id="optmute"><span class="track"></span></label>
	              <label class="sw">自动答题<input type="checkbox" id="optanswer"><span class="track"></span></label>
	              <label class="sw">自动暂存<input type="checkbox" id="opttempsave"><span class="track"></span></label>
	              <label class="sw">跳过已作答<input type="checkbox" id="optskipfilled"><span class="track"></span></label>
	            </div>

	            <div class="sect">
	              <span class="st">作答题型</span>
	            </div>
	            <div class="chips" id="typechips">
	              <span class="chip on" data-type="单选">单选题</span>
	              <span class="chip on" data-type="多选">多选题</span>
	              <span class="chip on" data-type="判断">判断题</span>
	            </div>

	            <div class="sect">
	              <span class="st">模型</span>
	              <span class="tag" id="tagllm">未配置</span>
	              <span class="llmname" id="llmmodel">—</span>
	              <span class="lnk" id="btnllm2">配置…</span>
	            </div>
	          </div>
	          <div class="col-right">
	            <div class="loghd">
	              <span class="st">运行日志</span>
	              <span class="cnt" id="logcnt"></span>
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
				status: root.getElementById("vstatus"),
				lesson: root.getElementById("vlesson"),
				task: root.getElementById("vtask"),
				answer: root.getElementById("vanswer"),
				barV: root.getElementById("barv"),
				barA: root.getElementById("bara"),
				cur: root.getElementById("vcur"),
				log: root.getElementById("vlog"),
				logCnt: root.getElementById("logcnt"),
				imgmask: root.getElementById("imgmask"),
				imgFull: root.getElementById("imgfull"),
				imgTitle: root.getElementById("imgtitle"),
				btnStart: root.getElementById("btnstart"),
				optMute: root.getElementById("optmute"),
				optAnswer: root.getElementById("optanswer"),
				optTempSave: root.getElementById("opttempsave"),
				optSkipFilled: root.getElementById("optskipfilled"),
				chips: root.getElementById("typechips"),
				tagLlm: root.getElementById("tagllm"),
				llmModel: root.getElementById("llmmodel"),
				titlebar: root.getElementById("titlebar"),
				body: root.getElementById("body"),
				btnMin: root.getElementById("btnmin"),
			};

			const ans = store.config("answer", ANSWER_DEFAULTS);
			el.optMute.checked = !!store.get("mute", false);
			el.optAnswer.checked = !!ans.enabled;
			el.optTempSave.checked = !!ans.autoTempSave;
			el.optSkipFilled.checked = !!ans.skipFilled;

			el.optMute.addEventListener("change", () => store.set("mute", el.optMute.checked));
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

			// 题型 chip
			el.chips.addEventListener("click", (e) => {
				const chip = e.target.closest(".chip");
				if (!chip) return;
				const type = chip.getAttribute("data-type");
				const cur = store.config("answer", ANSWER_DEFAULTS).types || {};
				const next = Object.assign({}, cur);
				next[type] = !(next[type] !== false);
				// 至少保留一种题型，避免全部取消后无心可用
				if (SUPPORTED_TYPES.every((t) => next[t] === false)) {
					Log.warn("至少需要保留一种作答题型");
					return;
				}
				patchAnswer({ types: next });
				syncChips();
			});

			el.btnStart.addEventListener("click", () => {
				if (S.running) Runner.stop();
				else Runner.start();
			});
			root.getElementById("btnllm2").addEventListener("click", () => ConfigUI.open());
			// 图片弹窗关闭
			root.getElementById("imgclose").addEventListener("click", closeImage);
			el.imgmask.addEventListener("click", (e) => {
				if (e.target === el.imgmask) closeImage();
			});
			root.addEventListener("keydown", (e) => {
				if (e.key === "Escape") closeImage();
			});
			el.btnMin.addEventListener("click", () => {
				const hidden = el.body.style.display === "none";
				el.body.style.display = hidden ? "" : "none";
				el.btnMin.textContent = hidden ? "—" : "+";
			});

			restorePosition();
			bindDrag();
			syncChips();
			refreshBadges();
		}

		/** 局部更新答题配置（避免覆盖其它字段） */
		function patchAnswer(patch) {
			const cur = store.config("answer", ANSWER_DEFAULTS);
			Object.keys(patch).forEach((k) => {
				cur[k] = patch[k];
			});
			store.set("answer", cur);
		}

		/** 同步题型 chip 的选中态 */
		function syncChips() {
			if (!el.chips) return;
			const types = store.config("answer", ANSWER_DEFAULTS).types || {};
			Dom.toArray(el.chips.querySelectorAll(".chip")).forEach((chip) => {
				const t = chip.getAttribute("data-type");
				const on = types[t] !== false;
				chip.classList.toggle("on", on);
			});
		}

		function refreshBadges() {
			if (!el.tagLlm) return;
			const cfg = store.config("llm", LLM_DEFAULTS);
			const ok = !!cfg.apiKey && !!cfg.baseUrl && !!cfg.model;
			el.tagLlm.textContent = ok ? "已配置" : "未配置";
			el.tagLlm.className = "tag" + (ok ? "" : " warn");
			if (el.llmModel) el.llmModel.textContent = ok ? cfg.model : "点击右侧「配置…」填写接口信息";
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
			let sx = 0,
				sy = 0,
				ox = 0,
				oy = 0,
				dragging = false;
			el.titlebar.addEventListener("pointerdown", (e) => {
				if (e.target.classList.contains("ibtn")) return;
				dragging = true;
				const r = host.getBoundingClientRect();
				sx = e.clientX;
				sy = e.clientY;
				ox = r.left;
				oy = r.top;
				host.style.right = "auto";
				try {
					el.titlebar.setPointerCapture(e.pointerId);
				} catch (err) {
					/* noop */
				}
			});
			el.titlebar.addEventListener("pointermove", (e) => {
				if (!dragging) return;
				const b = bounds();
				host.style.left = clamp(ox + e.clientX - sx, 0, b.maxX) + "px";
				host.style.top = clamp(oy + e.clientY - sy, 0, b.maxY) + "px";
			});
			const end = () => {
				if (!dragging) return;
				dragging = false;
				const r = host.getBoundingClientRect();
				store.set("panelPos", { x: Math.round(r.left), y: Math.round(r.top) });
			};
			el.titlebar.addEventListener("pointerup", end);
			el.titlebar.addEventListener("pointercancel", end);
		}

		// ============ 日志卡片流 ============
		// 每张卡片是一段独立的过程记录：系统信息 / 视频任务点 / 答题任务点 / 单道题目

		const cards = new Map(); // key → { node, body, badge, lines, kind }

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
			cards_total++;
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

		let cards_total = 0;
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
			updateLogCount();
		}

		function updateLogCount() {
			if (el.logCnt) el.logCnt.textContent = cards.size > 0 ? cards.size + " 张卡片" : "";
		}

		function autoscroll() {
			if (el.log) el.log.scrollTop = el.log.scrollHeight;
			updateLogCount();
		}

		/** 清空全部卡片（重新开始时调用） */
		function clearCards() {
			cards.clear();
			if (el.log) el.log.innerHTML = "";
			cards_total = 0;
			updateLogCount();
		}

		const STATUS_CLS = {
			运行中: "p-run",
			等待中: "p-wait",
			异常: "p-err",
			已完成: "p-done",
			已停止: "p-idle",
			未启动: "p-idle",
		};

		function setProgress(barEl, done, seen) {
			if (!barEl) return;
			const pct = seen > 0 ? Math.min(100, Math.round((done / seen) * 100)) : 0;
			barEl.style.width = pct + "%";
		}

		return {
			ensure,
			refreshBadges,
			syncChips,
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
				el.status.className = "pill " + (STATUS_CLS[s] || "p-idle");
				el.status.innerHTML = "<i></i>" + s;
			},
			setLesson(text) {
				if (el.lesson) el.lesson.textContent = text;
			},
			setTaskStat() {
				if (el.task) el.task.textContent = S.videoDone + " / " + S.videoSeen;
				setProgress(el.barV, S.videoDone, S.videoSeen);
			},
			setAnswerStat() {
				if (el.answer) el.answer.textContent = S.answerDone + " / " + S.answerSeen;
				setProgress(el.barA, S.answerDone, S.answerSeen);
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
	      :host { all: initial; }
	      * { box-sizing: border-box; margin: 0; padding: 0;
	          font-family: "Microsoft YaHei", "PingFang SC", -apple-system, sans-serif; }
	      .mask { position: fixed; inset: 0; background: rgba(15,23,42,.45); display: flex;
	              align-items: center; justify-content: center; z-index: 2147483600;
	              backdrop-filter: blur(2px); }
	      .dlg { width: 580px; max-height: 88vh; overflow: auto; background: #fff;
	             border-radius: 16px; box-shadow: 0 24px 64px rgba(15,23,42,.28);
	             font-size: 13px; color: #0f172a; }
	      .hd { padding: 18px 22px 14px; display: flex; justify-content: space-between;
	            align-items: center; border-bottom: 1px solid #eef2f7; position: sticky; top: 0;
	            background: #fff; border-radius: 16px 16px 0 0; z-index: 2; }
	      .hd .ttl { display: flex; align-items: center; gap: 9px; }
	      .hd .dot { width: 9px; height: 9px; border-radius: 50%; background: #4f46e5; }
	      .hd h3 { font-size: 15px; font-weight: 650; letter-spacing: .2px; }
	      .hd .x { cursor: pointer; width: 26px; height: 26px; border-radius: 7px; display: flex;
	               align-items: center; justify-content: center; color: #94a3b8; font-size: 17px;
	               transition: all .15s; }
	      .hd .x:hover { background: #fef2f2; color: #ef4444; }
	      .bd { padding: 6px 22px 4px; }
	      .sec { margin: 16px 0 10px; font-weight: 650; color: #334155; font-size: 12.5px;
	             display: flex; align-items: center; gap: 7px; }
	      .sec::before { content: ""; width: 3px; height: 13px; border-radius: 2px; background: #4f46e5; }
	      .sec .opt { color: #94a3b8; font-weight: 400; font-size: 11px; }
	      .grid { display: grid; grid-template-columns: 112px 1fr; gap: 10px 14px; align-items: center; }
	      .grid label { color: #64748b; font-size: 12.5px; }
	      .grid .hint { grid-column: 2; color: #94a3b8; font-size: 11px; margin-top: -5px;
	                    line-height: 1.5; }
	      input[type=text], input[type=password], input[type=number], select, textarea {
	        width: 100%; padding: 8px 11px; border: 1px solid #e2e8f0; border-radius: 9px;
	        font-size: 12.5px; color: #0f172a; background: #f8fafc; outline: none;
	        transition: all .15s; }
	      input:hover, select:hover, textarea:hover { border-color: #cbd5e1; }
	      input:focus, select:focus, textarea:focus { border-color: #818cf8; background: #fff;
	        box-shadow: 0 0 0 3px rgba(99,102,241,.12); }
	      textarea { min-height: 60px; resize: vertical; font-family: Consolas, monospace; }
	      .chk { display: flex; align-items: center; gap: 8px; color: #475569; font-size: 12.5px;
	             cursor: pointer; user-select: none; }
	      .chk input { width: 15px; height: 15px; accent-color: #4f46e5; cursor: pointer; }
	      .ft { display: flex; gap: 10px; padding: 16px 22px 20px; align-items: center;
	            position: sticky; bottom: 0; background: #fff; border-top: 1px solid #eef2f7;
	            border-radius: 0 0 16px 16px; }
	      .ft .grow { flex: 1; }
	      button { padding: 9px 18px; border: 0; border-radius: 9px; cursor: pointer;
	               font-size: 12.5px; font-weight: 600; transition: all .15s; }
	      .primary { background: #4f46e5; color: #fff; }
	      .primary:hover { background: #4338ca; }
	      .ghost { background: #f1f5f9; color: #475569; }
	      .ghost:hover { background: #e2e8f0; }
	      .test { background: #ecfdf5; color: #047857; }
	      .test:hover { background: #d1fae5; }
	      button:disabled { opacity: .5; cursor: not-allowed; }
	      .status { font-size: 12px; color: #64748b; max-width: 250px; overflow: hidden;
	                text-overflow: ellipsis; white-space: nowrap; }
	      .status.ok { color: #047857; }
	      .status.err { color: #dc2626; }
	      .status.warn { color: #b45309; }
	    </style>
	    <div class="mask">
	      <div class="dlg">
	        <div class="hd">
	          <span class="ttl"><span class="dot"></span><h3>模型配置</h3></span>
	          <span class="x" id="close">×</span>
	        </div>
	        <div class="bd">
	          <div class="sec">接口（OpenAI 兼容）</div>
	          <div class="grid">
	            <label>Base URL</label>
	            <input type="text" id="baseUrl" placeholder="https://api.openai.com/v1">
	            <div class="hint">通常以 /v1 结尾；脚本会自动补全 /chat/completions 或 /responses</div>

	            <label>API Key</label>
	            <input type="password" id="apiKey" placeholder="sk-...">
	            <div class="hint">仅保存在本地浏览器存储中，不会上传到任何第三方</div>

	            <label>模型</label>
	            <input type="text" id="model" placeholder="gpt-4o / qwen-vl-max / glm-4v ...">
	            <div class="hint">必须是支持图片输入的多模态模型（题目以位图发送）</div>

	            <label>接口风格</label>
	            <select id="apiStyle">
	              <option value="chat">Chat Completions（/chat/completions）</option>
	              <option value="responses">Responses API（/responses）</option>
	            </select>

	            <label>temperature</label>
	            <input type="number" id="temperature" step="0.1" min="0" max="2">

	            <label>max tokens</label>
	            <input type="number" id="maxTokens" step="128" min="64">

	            <label>额外请求头</label>
	            <textarea id="extraHeaders" placeholder='{"X-Foo":"bar"}'></textarea>
	          </div>

	          <div class="sec">高级 <span class="opt">（日常使用保持默认即可）</span></div>
	          <div class="grid">
	            <label>无答案时</label>
	            <select id="unknownAction">
	              <option value="skip">留空不作答（默认）</option>
	              <option value="guess">随机选一个（避免空题）</option>
	            </select>

	            <label>批量大小</label>
	            <input type="number" id="llmBatchSize" min="1" max="20">
	            <div class="hint">每次请求提交的题目数量；默认 1（逐题作答，日志最清晰）</div>

	            <label>其他</label>
	            <div class="chk"><input type="checkbox" id="debugDump"> 日志输出请求与响应原文（排错用）</div>
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
				llmBatchSize: root.getElementById("llmBatchSize"),
				debugDump: root.getElementById("debugDump"),
				status: root.getElementById("status"),
			};

			root.getElementById("close").addEventListener("click", close);
			root.getElementById("cancel").addEventListener("click", close);
			root.getElementById("save").addEventListener("click", save);
			root.getElementById("test").addEventListener("click", testConnection);
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
			fields.llmBatchSize.value = String(cfg.batchSize || CFG.llmBatchSize);
			fields.debugDump.checked = !!ans.debugDump;
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
				batchSize: parseInt(fields.llmBatchSize.value, 10) || CFG.llmBatchSize,
			};
			const ans = {
				unknownAction: fields.unknownAction.value,
				debugDump: fields.debugDump.checked,
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
			// 只覆盖本弹窗负责的字段，其余（自动暂存 / 题型勾选等）保留面板上的设置
			const merged = store.config("answer", ANSWER_DEFAULTS);
			merged.unknownAction = ans.unknownAction;
			merged.debugDump = ans.debugDump;
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

	/** 切换到指定课时（getTeacherAjax 为主，URL 整页跳转兜底） */
	async function gotoLesson(lesson) {
		const p = courseParams();
		const fn = window.getTeacherAjax;
		if (typeof fn === "function") {
			Log.info("切换课时（AJAX）：" + lesson.title);
			tagCardsWindowForReload();
			fn(p.courseId, p.clazzid, lesson.kid, p.cpi);
		} else {
			Log.warn("页面导航函数不可用，使用整页跳转兜底");
			const u = new URL(location.href);
			u.searchParams.set("chapterId", lesson.kid);
			location.href = u.toString();
			return; // 整页刷新后脚本重新初始化
		}
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
	}

	/** 切换课时内卡片（changeDisplayContent 为主，直改 iframe src 兜底） */
	async function switchCard(n, total, lesson) {
		const p = courseParams();
		const fn = window.changeDisplayContent;
		tagCardsWindowForReload();
		if (typeof fn === "function") {
			Log.info("切换到卡片 " + n + " / " + total);
			fn(n, total, lesson.kid, p.courseId, p.clazzid, "");
		} else {
			const f = cardsIframeEl();
			if (f)
				f.src =
					"/mooc-ans/knowledge/cards?clazzid=" +
					p.clazzid +
					"&courseid=" +
					p.courseId +
					"&knowledgeid=" +
					lesson.kid +
					"&num=" +
					(n - 1) +
					"&ut=s&cpi=" +
					p.cpi;
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

	/** 处理单个视频任务点（完成时返回判定来源） */
	async function handleVideoTask(job) {
		if (!job.iframe) throw new Error("未找到视频载体 iframe");
		const cardKey = "v:" + (job.jobid || job.title);

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

		// B. 安装完成信号（事件驱动优先）
		const signals = { passed: false, iconDone: false };
		installReportHook(vdoc, () => {
			signals.passed = true;
		});
		watchIconDone(job.icon, () => {
			signals.iconDone = true;
		});
		if (isIconDone(job.icon) || signals.iconDone) return "taskpoint"; // 进入时已完成（如上次异常退出）

		// C. 先启动播放，锁定 1 倍速。
		//    实测：VideoJS 惰性加载，未播放时 duration 为 null，必须先 play 元数据才会就绪。
		try {
			video.playbackRate = 1;
		} catch (e) {
			/* noop */
		}
		video.muted = !!store.get("mute", false);
		await ensurePlay(video);
		Log.use(cardKey);
		Log.info("开始播放");
		Log.meta(null, "播放中", "run");

		// D. 等待播放真正就绪（元数据加载或进度开始走）
		await waitFor(
			() => (isFinite(video.duration) && video.duration > 0) || video.currentTime > 0,
			{ timeout: 60000, interval: 500, desc: "视频开始加载" },
		);
		if (isFinite(video.duration) && video.duration > 0) {
			Log.use(cardKey);
			Log.info("时长 " + fmtTime(video.duration) + "，完成条件：观看 ≥ 总时长的 90%");
		}

		// E. 监控循环（1s 兜底轮询 + 事件信号）
		//    进度看门狗：实测暂停可能高频发生（CDN 抖动导致媒体源重载，不经过 video.pause()），
		//    因此不按"暂停次数"判失败，而是只要 currentTime 持续推进就一直恢复；
		//    只有长时间零进度才判定失败（重试→跳过）。
		let lastPct = -1,
			lastLogAt = 0,
			pauseResumes = 0;
		let progressAnchor = { t: video.currentTime, at: Date.now() };
		for (;;) {
			if (S.stopRequested) throw STOP;
			await sleep(CFG.monitorInterval);

			const v = vdoc.querySelector("video") || video;

			// 完成判定 1：任务点状态（图标 aria-label / 上报响应 isPassed）
			if (signals.passed || vdoc.__cxapPassed || signals.iconDone || isIconDone(job.icon)) {
				Log.use(cardKey);
				Log.info(
					"检测到完成（" +
						(signals.passed || vdoc.__cxapPassed ? "服务端 isPassed" : "页面任务点状态") +
						"）",
				);
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
				try {
					v.playbackRate = 1;
				} catch (e) {
					/* noop */
				}
				v.muted = !!store.get("mute", false);
				await ensurePlay(v);
				continue;
			}

			// 进度展示与节流日志（元数据未就绪时仅显示已播放时间）
			const hasDur = isFinite(v.duration) && v.duration > 0;
			const pct = hasDur ? Math.min(99, Math.floor((v.currentTime / v.duration) * 100)) : -1;
			Panel.setTask(
				pct >= 0
					? "播放中 " + pct + "%（" + fmtTime(v.currentTime) + " / " + fmtTime(v.duration) + "）"
					: "播放中（" + fmtTime(v.currentTime) + "）",
			);
			if (pct >= 0 && pct !== lastPct && Date.now() - lastLogAt > CFG.progressLogInterval) {
				lastPct = pct;
				lastLogAt = Date.now();
				Log.use(cardKey);
				Log.info("播放进度：" + pct + "%");
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
		async function run(job, ansCfg) {
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

			// 答题任务点独立一张卡片
			const jobKey = "job:" + (job.jobid || job.title);
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

	/** 单个视频任务点：有限重试 → 仍失败则记 ERROR 跳过（不中断整体） */
	async function processVideoWithRetry(job) {
		const cardKey = "v:" + (job.jobid || job.title);
		let lastErr = null;
		for (let attempt = 1; attempt <= CFG.maxJobRetries; attempt++) {
			if (S.stopRequested) throw STOP;
			try {
				Log.use(cardKey, {
					kind: "video",
					title: "视频任务点 · " + job.title,
					badge: "播放中",
					badgeCls: "run",
				});
				Panel.setStatus("运行中");
				Panel.setTask("分析视频：" + job.title);
				const via = await handleVideoTask(job);
				S.videoDone++;
				Panel.setTaskStat();
				Panel.setTask("当前视频任务点完成");
				Log.use(cardKey);
				Log.ok(
					"已完成（判定依据：" +
						(via === "taskpoint" ? "学习通任务点状态" : "视频播放结束") +
						"）",
				);
				Log.meta(null, "已完成", "ok");
				return;
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
		Log.meta(null, "已跳过", "err");
		await sleep(1500); // 给用户看清日志
	}

	/** 单个答题任务点：有限重试 → 仍失败则记 ERROR 跳过 */
	async function processAnswerWithRetry(job) {
		const ansCfg = store.config("answer", ANSWER_DEFAULTS);
		const cardKey = "job:" + (job.jobid || job.title);
		let lastErr = null;
		for (let attempt = 1; attempt <= CFG.maxJobRetries; attempt++) {
			if (S.stopRequested) throw STOP;
			try {
				Panel.setStatus("运行中");
				Panel.setTask("分析答题：" + job.title);
				const stat = await AnswerTask.run(job, ansCfg);
				if (stat.status === "skipped") return;
				if (stat.status === "aborted") {
					// 环境/配置类问题：重试无意义，直接抛出以停止整个任务
					throw new Error("模型请求环境不可用，已中止答题（详见日志）");
				}
				if (stat.status === "failed") {
					lastErr = new Error(stat.saved ? "暂存未成功" : "答题未完成");
					throw lastErr;
				}
				S.answerDone++;
				Panel.setAnswerStat();
				Panel.setTask("当前答题任务点完成");
				return;
			} catch (e) {
				if (e === STOP) throw e;
				lastErr = e;
				Log.use(cardKey, {
					kind: "job",
					title: "答题任务点 · " + job.title,
				});
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
		Log.use(cardKey);
		Panel.setStatus("异常");
		Log.error("重试后仍未完成，跳过并继续后续任务（" + (lastErr && lastErr.message) + "）");
		Log.meta(null, "已跳过", "err");
		await sleep(1500);
	}

	async function run() {
		S.stopRequested = false;
		S.videoSeen = 0;
		S.videoDone = 0;
		S.answerSeen = 0;
		S.answerDone = 0;
		S.lessonIdx = -1;
		Panel.setTaskStat();
		Panel.setAnswerStat();
		Panel.setTask("准备中");
		// 新一轮运行：清空上一轮的日志卡片，避免混淆
		Panel.clearCards();
		Log.useSystem();

		const ansCfg = store.config("answer", ANSWER_DEFAULTS);
		const llmCfg = store.config("llm", LLM_DEFAULTS);
		if (ansCfg.enabled && (!llmCfg.apiKey || !llmCfg.model)) {
			Log.warn("自动答题已开启但 LLM 未配置，答题任务点将被跳过（请在面板「配置…」中设置）");
		}

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

		// ---- 逐课时处理 ----
		for (let i = idx; i < S.lessons.length; i++) {
			if (S.stopRequested) throw STOP;
			const lesson = S.lessons[i];
			S.lessonIdx = i;
			Panel.setLesson(i + 1 + " / " + S.lessons.length + "　" + lesson.title);
			Log.info("进入：" + lesson.title + "（" + (i + 1) + "/" + S.lessons.length + "）");

			// 整课时已无未完成任务点（渲染快照）→ 快速跳过
			if (lesson.unfinished === 0) {
				Log.skip("该课时全部任务点已完成，跳过");
				continue;
			}

			// 页面不在该课时 → 切换
			const active = document.querySelector("." + SEL.currentLessonActive);
			const onLesson =
				(active && active.id === "cur" + lesson.kid) ||
				(cardsIframeEl() && (cardsIframeEl().src || "").indexOf("knowledgeid=" + lesson.kid) !== -1);
			if (!onLesson) await gotoLesson(lesson);

			// 该课时包含的所有卡片依次处理
			const tabCount = document.querySelectorAll(SEL.cardTabs).length;
			const total = Math.max(tabCount, 1);
			let lessonJobCount = 0;

			for (let n = 1; n <= total; n++) {
				if (S.stopRequested) throw STOP;
				if (n > 1) await switchCard(n, total, lesson);
				const doc = await waitForCardsReady(lesson.kid, n - 1);

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
						Panel.setTaskStat();
						if (job.done) {
							S.videoDone++;
							Panel.setTaskStat();
							Log.info("视频任务点已完成，跳过：" + job.title);
							continue;
						}
						lessonJobCount++;
						await processVideoWithRetry(job);
					} else if (job.type === "answer") {
						S.answerSeen++;
						Panel.setAnswerStat();
						if (job.done) {
							S.answerDone++;
							Panel.setAnswerStat();
							Log.info("答题任务点已完成，跳过：" + job.title);
							continue;
						}
						lessonJobCount++;
						await processAnswerWithRetry(job);
					} else {
						Log.skip("跳过其他任务点「" + job.title + "」（类型：" + job.type + "）");
					}
				}
			}

			if (!lessonJobCount) Log.skip("当前课时不包含待处理的任务点，跳过");
			Log.info("课时处理完成，准备进入下一个课时");
		}

		// ---- FINISHED ----
		Panel.setStatus("已完成");
		Panel.setTask("全部完成");
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
		const ver = (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || "0.2.0";
		Log.useSystem();
		Log.info("脚本已加载（v" + ver + "）｜点击「开始刷课」启动");
		const llmCfg = store.config("llm", LLM_DEFAULTS);
		if (llmCfg.apiKey && llmCfg.model) {
			Log.info("自动答题已就绪（模型：" + llmCfg.model + "）");
		} else {
			Log.warn("自动答题未配置：点击面板「模型」行的「配置…」填写 Base URL / API Key / 多模态模型");
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
				scanCardJobs,
				scanLessons,
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
