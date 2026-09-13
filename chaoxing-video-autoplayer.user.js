// ==UserScript==
// @name         学习通视频任务点自动刷课助手
// @namespace    cx-video-autoplayer
// @version      0.1.0
// @description  自动遍历学习通课程课时，处理未完成的视频任务点（跳过答题任务点），带可拖动悬浮控制面板与实时日志。基于 2026-09 实际页面结构分析实现。
// @author       Copilot
// @match        *://mooc1.chaoxing.com/mycourse/studentstudy*
// @match        *://mooc1-ans.chaoxing.com/mycourse/studentstudy*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * ============================== 调研结论（实现依据） ==============================
 *
 * 1. 页面框架结构（全部同源 mooc1.chaoxing.com，脚本只在顶层运行，直接跨 iframe 访问）：
 *    顶层 studentstudy
 *      └─ iframe#iframe  → /mooc-ans/knowledge/cards?...&knowledgeid=<课时id>&num=<卡片序号0起>
 *           └─ 视频任务点 iframe  → /ananas/modules/video/index.html（VideoJS 播放器）
 *
 * 2. 课程目录（顶层）：
 *    - 课时行: div.posCatalog_select（含 .posCatalog_name 才是课时，含 .posCatalog_title 的是章节头）
 *    - 课时 knowledgeid: 行元素 id = "cur<knowledgeid>"
 *    - 当前课时: 行元素带 class posCatalog_active
 *    - 未完成任务点总数: 行内 input.jobUnfinishCount（含测验，仅渲染时快照，不实时更新，仅作快速跳过依据）
 *    - 课时点击导航: 全局函数 getTeacherAjax(courseId, clazzid, knowledgeId, cpi)（AJAX 替换 #mainid，无整页刷新）
 *
 * 3. 课时内卡片（顶层 #mainid 区域）：
 *    - 卡片标签: ul.prev_ul li[id^="dct"]（onclick=changeDisplayContent(n,total,kid,cid,clzid,'')）
 *    - 课时切换用 changeDisplayContent，课时整体切换用 getTeacherAjax
 *
 * 4. 任务点（cards 框内）：
 *    - 图标: .ans-job-icon，aria-label = "任务点已完成" / "任务点未完成"（服务端渲染初始即准确，完成时实时翻转 —— 最终依据）
 *    - 视频任务点: 图标带 ans-job-video 类；载体 iframe.ans-insertvideo-online（src 含 /ananas/modules/video/，
 *      data 属性为 JSON: {objectid, name, mid, jobid, _jobid, fastforward, doublespeed}）
 *    - 作业/测验任务点: 载体 iframe src 含 /ananas/modules/work/（data 含 workid/worktype），图标无 ans-job-video
 *    - 任务点容器: .ans-attach-ct（视频卡片带 videoContainer 类）；视频内弹题容器: #topicList
 *
 * 5. 视频播放器（video 框内）：
 *    - VideoJS: video#video_html5_api.vjs-tech，直接可用 currentTime / duration / paused / ended / play()
 *    - 进度上报: 每 ~60s GET /mooc-ans/multimedia/log/a/{cpi}/{enc}?...playingTime&duration&clipTime&objectId...
 *      响应 JSON: {"isPassed":bool,"videoTimeLimit":bool,"hasJobLimit":bool}
 *      *** isPassed:true 即服务端判定任务点完成（观看时长 ≥ 90%）***
 *    - 限制: 未完成任务点前拖拽会被回退；倍速锁定 1x
 *    - 播放结束: video.ended=true 且 paused=true，无额外弹窗
 *
 * 6. 完成判定优先级：图标 aria-label 已完成 / 上报响应 isPassed:true（任一即完成），
 *    兜底：视频 ended 且 currentTime ≥ duration-1.5 后等待 20s 任务点状态，仍未更新则按视频完成处理。
 * ========================================================================== */

(function () {
	"use strict";

	// ========================= 0. 选择器集中配置 =========================
	const SEL = {
		catalogLessonRow: "#coursetree .posCatalog_select", // 目录中的行（章节头+课时）
		lessonName: ".posCatalog_name", // 课时名（章节头没有）
		lessonUnfinished: "input.jobUnfinishCount", // 课时未完成任务点总数
		currentLessonActive: "posCatalog_active", // 当前课时标记 class
		cardTabs: 'ul.prev_ul li[id^="dct"]', // 课时内卡片标签
		mainIframe: "#iframe", // cards 内容 iframe
		jobIcon: ".ans-job-icon", // 任务点图标
		jobAttach: ".ans-attach-ct", // 任务点容器
	};

	const URL_VIDEO_MODULE = "/ananas/modules/video/"; // 视频任务点 iframe 特征
	const RE_ANSWER_MODULE = /\/ananas\/modules\/(work|quiz|exam)\//; // 答题类任务点特征
	const REPORT_URL_KEYWORD = "/multimedia/log/"; // 进度上报接口特征

	const ICON_DONE_KEYWORD = "已完成"; // aria-label 判定关键词（"任务点已完成"，注意"未完成"不含"已完成"）

	const CFG = {
		cardLoadTimeout: 30000, // 等待卡片 iframe 就绪超时
		videoFindTimeout: 25000, // 等待 video 元素出现超时
		endedGraceTimeout: 20000, // 视频结束后等待任务点状态更新时间
		navTimeout: 40000, // 课时切换等待超时
		maxPauseResumes: 500, // 单任务点恢复播放的绝对上限（兜底；实际由进度看门狗主导）
		noProgressTimeout: 180000, // 视频currentTime持续无推进的最长容忍时间（超时判失败）
		maxJobRetries: 2, // 单个任务点重试次数上限
		monitorInterval: 1000, // 监控轮询间隔（兜底，事件驱动为主）
		progressLogInterval: 30000, // 播放进度日志输出间隔
		logMaxRows: 200, // 面板日志最大条数
	};

	// ========================= 1. 存储封装（GM_* 优先） =========================
	const store = {
		get(k, d) {
			try {
				if (typeof GM_getValue === "function") {
					const v = GM_getValue("cxap_" + k, undefined);
					return v === undefined
						? d
						: typeof v === "string"
							? safeParse(v, v)
							: v;
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
	};
	function safeParse(s, d) {
		try {
			return JSON.parse(s);
		} catch (e) {
			return d;
		}
	}

	// ========================= 2. 全局运行状态 =========================
	const STOP = Symbol("cxap-stop"); // 停止信号（唯一标识）

	const S = {
		running: false,
		stopRequested: false,
		status: "未启动",
		lessons: [], // 课程课时列表（按页面顺序）
		lessonIdx: -1, // 当前处理的课时下标
		videoSeen: 0, // 已发现的视频任务点数
		videoDone: 0, // 已确认完成的视频任务点数
		taskLabel: "—",
		pending: new Set(), // 挂起的 sleep 项（停止时统一拒绝）
		observers: [], // 当前活跃的 MutationObserver
	};

	// ========================= 3. 日志 =========================
	const Log = {
		push(level, msg) {
			const time = new Date().toTimeString().slice(0, 8);
			const line = "[" + time + "][" + level + "] " + msg;
			try {
				console.log("[刷课助手] " + line);
			} catch (e) {
				/* noop */
			}
			Panel.appendLog(level, line);
		},
		info(m) {
			this.push("INFO", m);
		},
		skip(m) {
			this.push("SKIP", m);
		},
		warn(m) {
			this.push("WARN", m);
		},
		error(m) {
			this.push("ERROR", m);
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

	// 轮询等待条件成立（事件驱动之外的兜底手段）
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

	// ========================= 5. 悬浮控制面板（Shadow DOM 隔离） =========================
	const Panel = (function () {
		let host = null,
			root = null,
			el = {};
		let logRows = 0;

		const HTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; }
        .panel { width: 330px; background: #fff; border-radius: 10px; overflow: hidden;
                 box-shadow: 0 6px 24px rgba(0,0,0,.28); font-size: 12px; color: #333; }
        .titlebar { background: linear-gradient(90deg, #2f6fed, #5a9bff); color: #fff; padding: 8px 12px;
                    display: flex; justify-content: space-between; align-items: center; cursor: move; user-select: none; }
        .titlebar .t { font-weight: 600; font-size: 13px; letter-spacing: .5px; }
        .titlebar .min { cursor: pointer; font-size: 16px; line-height: 1; padding: 0 4px; opacity: .85; }
        .titlebar .min:hover { opacity: 1; }
        .body { padding: 10px 12px; }
        .row { display: flex; justify-content: space-between; align-items: center; margin: 3px 0; }
        .k { color: #8a94a6; flex-shrink: 0; }
        .v { font-weight: 600; text-align: right; max-width: 220px; overflow: hidden;
             text-overflow: ellipsis; white-space: nowrap; }
        .st-running { color: #2e9e44; } .st-stopped { color: #8a94a6; }
        .st-waiting { color: #d48806; } .st-error { color: #e03131; } .st-done { color: #2f6fed; }
        .btns { display: flex; gap: 8px; margin: 9px 0 6px; }
        .btns button { flex: 1; padding: 7px 0; border: 0; border-radius: 6px; cursor: pointer;
                       font-size: 12px; color: #fff; font-weight: 600; }
        .b-start { background: #2e9e44; } .b-stop { background: #e03131; }
        .btns button:disabled { opacity: .45; cursor: not-allowed; }
        .opts { display: flex; gap: 14px; margin: 2px 0 6px; color: #667; user-select: none; }
        .opts label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
        .log { margin-top: 4px; height: 190px; overflow-y: auto; background: #0f1420; border-radius: 6px;
               padding: 7px 8px; line-height: 1.55; }
        .log::-webkit-scrollbar { width: 6px; } .log::-webkit-scrollbar-thumb { background: #3a4664; border-radius: 3px; }
        .log .ln { white-space: pre-wrap; word-break: break-all; color: #9fb3c8; }
        .log .INFO { color: #7fd18c; } .log .SKIP { color: #8ab4ff; }
        .log .WARN { color: #f5c26b; } .log .ERROR { color: #ff8787; }
      </style>
      <div class="panel">
        <div class="titlebar" id="titlebar">
          <span class="t">学习通刷课助手</span><span class="min" id="btnmin">—</span>
        </div>
        <div class="body" id="body">
          <div class="row"><span class="k">状态</span><span class="v" id="vstatus">未启动</span></div>
          <div class="row"><span class="k">课时</span><span class="v" id="vlesson">—</span></div>
          <div class="row"><span class="k">视频任务点</span><span class="v" id="vtask">0 / 0</span></div>
          <div class="row"><span class="k">当前任务</span><span class="v" id="vcur">—</span></div>
          <div class="btns">
            <button class="b-start" id="btnstart">开始刷课</button>
            <button class="b-stop" id="btnstop" disabled>停止刷课</button>
          </div>
          <div class="opts">
            <label><input type="checkbox" id="optauto"> 自动启动</label>
            <label><input type="checkbox" id="optmute"> 静音播放</label>
          </div>
          <div class="log" id="vlog"></div>
        </div>
      </div>`;

		function ensure() {
			if (host && host.isConnected) return;
			host = document.createElement("div");
			host.id = "cxap-panel-host";
			host.style.cssText =
				"position:fixed;z-index:2147483000;top:70px;right:16px;";
			root = host.attachShadow({ mode: "open" });
			root.innerHTML = HTML;
			document.body.appendChild(host);

			el = {
				status: root.getElementById("vstatus"),
				lesson: root.getElementById("vlesson"),
				task: root.getElementById("vtask"),
				cur: root.getElementById("vcur"),
				log: root.getElementById("vlog"),
				btnStart: root.getElementById("btnstart"),
				btnStop: root.getElementById("btnstop"),
				optAuto: root.getElementById("optauto"),
				optMute: root.getElementById("optmute"),
				titlebar: root.getElementById("titlebar"),
				body: root.getElementById("body"),
				btnMin: root.getElementById("btnmin"),
			};

			// 选项初始化
			el.optAuto.checked = !!store.get("autoStart", false);
			el.optMute.checked = !!store.get("mute", false);
			el.optAuto.addEventListener("change", () =>
				store.set("autoStart", el.optAuto.checked),
			);
			el.optMute.addEventListener("change", () =>
				store.set("mute", el.optMute.checked),
			);

			// 按钮
			el.btnStart.addEventListener("click", () => Runner.start());
			el.btnStop.addEventListener("click", () => Runner.stop());
			el.btnMin.addEventListener("click", () => {
				const hidden = el.body.style.display === "none";
				el.body.style.display = hidden ? "" : "none";
				el.btnMin.textContent = hidden ? "—" : "+";
			});

			restorePosition();
			bindDrag();
		}

		function restorePosition() {
			const pos = store.get("panelPos", null);
			if (pos && typeof pos.x === "number" && typeof pos.y === "number") {
				host.style.right = "auto";
				host.style.left = clamp(pos.x, 0, window.innerWidth - 80) + "px";
				host.style.top = clamp(pos.y, 0, window.innerHeight - 40) + "px";
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
				if (e.target === el.btnMin) return;
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
				host.style.left =
					clamp(ox + e.clientX - sx, 0, window.innerWidth - 60) + "px";
				host.style.top =
					clamp(oy + e.clientY - sy, 0, window.innerHeight - 40) + "px";
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

		function appendLog(level, line) {
			if (!el.log) return;
			const d = document.createElement("div");
			d.className = "ln " + level;
			d.textContent = line;
			el.log.appendChild(d);
			logRows++;
			while (logRows > CFG.logMaxRows && el.log.firstChild) {
				el.log.removeChild(el.log.firstChild);
				logRows--;
			}
			el.log.scrollTop = el.log.scrollHeight;
		}

		const STATUS_CLS = {
			运行中: "st-running",
			等待中: "st-waiting",
			异常: "st-error",
			已完成: "st-done",
			已停止: "st-stopped",
			未启动: "st-stopped",
		};

		return {
			ensure,
			appendLog,
			setStatus(s) {
				S.status = s;
				if (!el.status) return;
				el.status.textContent = s;
				el.status.className = "v " + (STATUS_CLS[s] || "");
				el.btnStart.disabled = s === "运行中" || s === "等待中";
				el.btnStop.disabled = !(s === "运行中" || s === "等待中");
			},
			setLesson(text) {
				if (el.lesson) el.lesson.textContent = text;
			},
			setTaskStat() {
				if (el.task) el.task.textContent = S.videoDone + " / " + S.videoSeen;
			},
			setTask(text) {
				S.taskLabel = text;
				if (el.cur) el.cur.textContent = text;
			},
		};
	})();

	// ========================= 6. 页面访问层（CourseScanner / Frames） =========================
	function courseParams() {
		const q = new URLSearchParams(location.search);
		return {
			courseId: q.get("courseId") || String(window.courseId || ""),
			clazzid: q.get("clazzid") || q.get("clazzId") || "",
			cpi: q.get("cpi") || "",
			chapterId: q.get("chapterId") || String(window.chapterId || ""),
		};
	}

	// 扫描目录：按页面实际 DOM 顺序返回课时列表
	function scanLessons() {
		const rows = Array.prototype.slice
			.call(document.querySelectorAll(SEL.catalogLessonRow))
			.filter((r) => r.querySelector(SEL.lessonName)); // 排除章节头（章节头只有 .posCatalog_title）
		return rows
			.map((row) => {
				const nameEl = row.querySelector(SEL.lessonName);
				const unfinishedEl = row.querySelector(SEL.lessonUnfinished);
				return {
					kid: (row.id || "").replace(/^cur/, ""),
					title:
						nameEl.getAttribute("title") || (nameEl.textContent || "").trim(),
					unfinished: unfinishedEl ? parseInt(unfinishedEl.value, 10) : -1,
					isCurrent: row.classList.contains(SEL.currentLessonActive),
				};
			})
			.filter((l) => l.kid);
	}

	function cardsIframeEl() {
		return document.querySelector(SEL.mainIframe);
	}

	// 等待卡片 iframe 就绪（指定课时 + 卡片序号 0 起）。
	// expectNew=true 时要求 iframe 装载了"新文档"——切换前先 tagCardsWindowForReload()
	// 给旧窗口打标，避免 src 已变但 contentDocument 仍是上一张卡片内容的竞态（实测踩坑）。
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
				if (
					num0 !== null &&
					num0 !== undefined &&
					src.indexOf("num=" + num0) === -1
				)
					return null;
				try {
					const w = f.contentWindow;
					if (!w || !w.document) return null;
					if (expectNew && w.__cxapOldWindow) return null; // 仍是切换前的旧文档
					const d = w.document;
					if (
						d.readyState !== "complete" ||
						!d.body ||
						d.body.children.length === 0
					)
						return null;
					return d;
				} catch (e) {
					return null;
				}
			},
			{
				timeout: timeout || CFG.cardLoadTimeout,
				interval: 400,
				desc: "卡片内容加载",
			},
		);
	}

	// 切换到指定课时（getTeacherAjax 为主，URL 整页跳转兜底）
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
				const iframeOk =
					f && (f.src || "").indexOf("knowledgeid=" + lesson.kid) !== -1;
				return activeOk || iframeOk ? true : null;
			},
			{ timeout: CFG.navTimeout, interval: 500, desc: "课时切换生效" },
		);
		await waitForCardsReady(lesson.kid, 0, undefined, true);
	}

	// 切换课时内卡片（changeDisplayContent 为主，直改 iframe src 兜底）
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

	// 扫描当前卡片内所有任务点
	function scanCardJobs(doc) {
		const jobs = [];
		Array.prototype.slice
			.call(doc.querySelectorAll(SEL.jobIcon))
			.forEach((icon) => {
				const attach = icon.closest(SEL.jobAttach) || icon.parentElement;
				const ifr = attach ? attach.querySelector("iframe") : null;
				const src = ifr ? ifr.getAttribute("src") || "" : "";
				let type = "other";
				if (
					icon.classList.contains("ans-job-video") ||
					src.indexOf(URL_VIDEO_MODULE) !== -1
				)
					type = "video";
				else if (RE_ANSWER_MODULE.test(src)) type = "answer";

				let jobid = ifr
					? ifr.getAttribute("jobid") || ifr.getAttribute("_jobid")
					: null;
				if (!jobid && ifr && ifr.getAttribute("data")) {
					const d = safeParse(ifr.getAttribute("data"), null);
					if (d && d.jobid) jobid = String(d.jobid);
				}
				jobs.push({
					type,
					jobid: jobid || "",
					title: jobTitle(attach, src),
					icon,
					iframe: ifr,
					done: isIconDone(icon),
				});
			});
		return jobs;
	}

	function jobTitle(attach, src) {
		// 尽量从 data 属性取任务名（视频 data.name / 作业 data.title）
		if (attach) {
			const ifr = attach.querySelector("iframe");
			if (ifr && ifr.getAttribute("data")) {
				const d = safeParse(ifr.getAttribute("data"), null);
				if (d && (d.name || d.title)) return String(d.name || d.title);
			}
		}
		const m = src.match(/modules\/([a-z]+)\//);
		return m ? m[1] : "任务点";
	}

	function isIconDone(icon) {
		return (
			!icon ||
			(icon.getAttribute("aria-label") || "").indexOf(ICON_DONE_KEYWORD) !== -1
		);
	}

	// ========================= 7. 视频控制器（VideoController） =========================
	// 在视频 iframe 的 window 上挂钩 XMLHttpRequest，捕获进度上报响应中的 isPassed
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
					if (
						xhr.__cxapUrl &&
						xhr.__cxapUrl.indexOf(REPORT_URL_KEYWORD) !== -1
					) {
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
									if (typeof win.__cxapOnPassed === "function")
										win.__cxapOnPassed();
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

	// 监听任务点图标 aria-label 翻转（事件驱动）
	function watchIconDone(icon, onDone) {
		try {
			const obs = new MutationObserver(() => {
				if (isIconDone(icon)) onDone();
			});
			obs.observe(icon, {
				attributes: true,
				attributeFilter: ["aria-label", "class"],
			});
			S.observers.push(obs);
			return obs;
		} catch (e) {
			return null;
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
		Panel.appendLog(
			"WARN",
			"[WARN] 浏览器拦截了带声音的自动播放，已切换为静音播放",
		);
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

	// 处理单个视频任务点（完成时返回判定来源）
	async function handleVideoTask(job) {
		if (!job.iframe) throw new Error("未找到视频载体 iframe");

		// A. 等待视频框与 video 元素
		const vdoc = await waitFor(
			() => {
				try {
					const d = job.iframe.contentDocument;
					if (
						d &&
						d.readyState === "complete" &&
						d.body &&
						d.querySelector("video")
					)
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
		Log.info("视频开始播放：" + (job.title || "未命名"));

		// D. 等待播放真正就绪（元数据加载或进度开始走）
		await waitFor(
			() =>
				(isFinite(video.duration) && video.duration > 0) ||
				video.currentTime > 0,
			{ timeout: 60000, interval: 500, desc: "视频开始加载" },
		);
		if (isFinite(video.duration) && video.duration > 0) {
			Log.info(
				"视频时长 " +
					fmtTime(video.duration) +
					"，完成条件：观看时长 ≥ 总时长的 90%",
			);
		}

		// D. 监控循环（1s 兜底轮询 + 事件信号）
		//    进度看门狗：实测暂停可能高频发生（CDN 抖动导致媒体源重载，不经过 video.pause()，
		//    钩子捕获为 0），因此不按"暂停次数"判失败，而是只要 currentTime 持续推进就一直恢复；
		//    只有长时间零进度才判定失败（重试→跳过）。
		let lastPct = -1,
			lastLogAt = 0,
			pauseResumes = 0;
		let progressAnchor = { t: video.currentTime, at: Date.now() };
		for (;;) {
			if (S.stopRequested) throw STOP;
			await sleep(CFG.monitorInterval);

			const v =
				(vdoc.querySelector("video") && vdoc.querySelector("video")) || video;

			// 完成判定 1：任务点状态（图标 aria-label / 上报响应 isPassed）
			if (
				signals.passed ||
				vdoc.__cxapPassed ||
				signals.iconDone ||
				isIconDone(job.icon)
			) {
				Log.info(
					"检测到任务点完成（" +
						(signals.passed || vdoc.__cxapPassed
							? "服务端 isPassed"
							: "页面任务点状态") +
						"）",
				);
				return "taskpoint";
			}

			// 完成判定 2：视频播放完成 → 等待任务点状态同步
			if (
				v.ended ||
				(isFinite(v.duration) &&
					v.duration > 0 &&
					v.currentTime >= v.duration - 1.5)
			) {
				Log.info("视频播放完成，等待任务点状态更新…");
				let ok = false;
				try {
					ok = await waitFor(
						() =>
							signals.passed ||
							vdoc.__cxapPassed ||
							signals.iconDone ||
							isIconDone(job.icon),
						{
							timeout: CFG.endedGraceTimeout,
							interval: 800,
							desc: "任务点状态同步",
						},
					);
				} catch (e) {
					if (e === STOP) throw e;
				}
				if (ok) {
					Log.info("检测到任务点完成");
					return "taskpoint";
				}
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
					throw new Error(
						"视频反复暂停，已达到恢复上限（" + CFG.maxPauseResumes + " 次）",
					);
				}
				pauseResumes++;
				Log.warn("检测到视频被暂停，自动恢复播放（" + pauseResumes + "）");
				// 媒体元素可能已被页面重载替换，重新应用播放偏好
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
			const pct = hasDur
				? Math.min(99, Math.floor((v.currentTime / v.duration) * 100))
				: -1;
			Panel.setTask(
				pct >= 0
					? "正在播放 " +
							pct +
							"%（" +
							fmtTime(v.currentTime) +
							" / " +
							fmtTime(v.duration) +
							"）"
					: "正在播放（" + fmtTime(v.currentTime) + "）",
			);
			if (
				pct >= 0 &&
				pct !== lastPct &&
				Date.now() - lastLogAt > CFG.progressLogInterval
			) {
				lastPct = pct;
				lastLogAt = Date.now();
				Log.info("视频播放进度：" + pct + "%");
			}
		}
	}

	// ========================= 8. 任务处理器（含 LLM 答题预留） =========================
	const LLMAnswerProvider = {
		configured: false, // 未来在此配置 LLM 接口
		async getAnswer(task) {
			throw new Error("LLMAnswerProvider 未配置");
		},
	};

	async function handleAnswerTask(job) {
		// TODO: 未来接入 LLM 答题 —— 调用 LLMAnswerProvider.getAnswer(job)
		Log.skip(
			"跳过答题任务点「" +
				job.title +
				"」（答题功能未启用，LLM " +
				(LLMAnswerProvider.configured ? "已配置" : "未配置") +
				"）",
		);
	}

	async function handleOtherTask(job) {
		Log.skip("跳过非视频任务点「" + job.title + "」（类型：" + job.type + "）");
	}

	const TaskHandlers = {
		video: handleVideoTask, // 视频任务点 → 自动处理
		answer: handleAnswerTask, // 答题任务点 → 预留接口，当前跳过
		default: handleOtherTask, // 其他任务点 → 跳过
	};

	// ========================= 9. 主流程（Runner 状态机） =========================
	function refreshCatalog() {
		S.lessons = scanLessons();
		if (S.lessonIdx >= 0) {
			const idx = S.lessons.findIndex(
				(l) => l.kid === (S.lessons[S.lessonIdx] || {}).kid,
			);
			if (idx >= 0) S.lessonIdx = idx;
		}
	}

	async function run() {
		S.stopRequested = false;
		S.videoSeen = 0;
		S.videoDone = 0;
		S.lessonIdx = -1;
		Panel.setTaskStat();
		Panel.setTask("准备中");

		// ---- SCANNING：扫描课程目录 ----
		Panel.setStatus("运行中");
		Log.info("开始扫描课程目录");
		S.lessons = scanLessons();
		if (!S.lessons.length)
			throw new Error("未找到课程目录/课时列表，页面结构可能已变化");
		Log.info("找到 " + S.lessons.length + " 个课时");

		// 定位当前课时
		let idx = S.lessons.findIndex((l) => l.isCurrent);
		if (idx < 0)
			idx = S.lessons.findIndex((l) => l.kid === courseParams().chapterId);
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
			Log.info(
				"进入：" +
					lesson.title +
					"（" +
					(i + 1) +
					"/" +
					S.lessons.length +
					"）",
			);

			// 整课时已无未完成任务点（渲染快照）→ 快速跳过
			if (lesson.unfinished === 0) {
				Log.skip("该课时全部任务点已完成，跳过");
				continue;
			}

			// 页面不在该课时 → 切换
			const active = document.querySelector("." + SEL.currentLessonActive);
			const onLesson =
				(active && active.id === "cur" + lesson.kid) ||
				(cardsIframeEl() &&
					(cardsIframeEl().src || "").indexOf("knowledgeid=" + lesson.kid) !==
						-1);
			if (!onLesson) await gotoLesson(lesson);

			// 该课时包含的所有卡片依次处理
			const tabCount = document.querySelectorAll(SEL.cardTabs).length;
			const total = Math.max(tabCount, 1);
			let lessonHasVideo = false;

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

				const videos = jobs.filter((j) => j.type === "video");
				// 非视频任务点先记录跳过
				jobs.forEach((j) => {
					if (j.type !== "video")
						TaskHandlers[j.type === "answer" ? "answer" : "default"](j);
				});
				if (!videos.length) continue;
				lessonHasVideo = true;

				// ---- 处理本卡片内视频任务点（按 DOM 顺序） ----
				for (const job of videos) {
					if (S.stopRequested) throw STOP;
					S.videoSeen++;
					Panel.setTaskStat();

					if (job.done) {
						S.videoDone++;
						Panel.setTaskStat();
						Log.info("视频任务点已完成，跳过：" + job.title);
						continue;
					}

					await processVideoWithRetry(job);
				}
			}

			if (!lessonHasVideo) Log.skip("当前课时不包含视频任务点，跳过");
			Log.info("课时处理完成，准备进入下一个课时");
		}

		// ---- FINISHED ----
		Panel.setStatus("已完成");
		Panel.setTask("全部完成");
		Log.info(
			"课程所有视频任务点处理完毕，共完成 " + S.videoDone + " 个视频任务点",
		);
	}

	// 单个视频任务点：有限重试 → 仍失败则记 ERROR 跳过（不中断整体）
	async function processVideoWithRetry(job) {
		let lastErr = null;
		for (let attempt = 1; attempt <= CFG.maxJobRetries; attempt++) {
			if (S.stopRequested) throw STOP;
			try {
				Panel.setStatus("运行中");
				Panel.setTask("分析视频：" + job.title);
				const via = await handleVideoTask(job);
				S.videoDone++;
				Panel.setTaskStat();
				Panel.setTask("当前视频任务点完成");
				Log.info(
					"当前视频任务点完成（判定依据：" +
						(via === "taskpoint" ? "学习通任务点状态" : "视频播放结束") +
						"）",
				);
				return;
			} catch (e) {
				if (e === STOP) throw e;
				lastErr = e;
				Log.error(
					"视频任务点处理异常（第 " +
						attempt +
						"/" +
						CFG.maxJobRetries +
						" 次）：" +
						e.message,
				);
				if (attempt < CFG.maxJobRetries) {
					Panel.setStatus("等待中");
					Panel.setTask("等待重试");
					await sleep(3000);
				}
			}
		}
		Panel.setStatus("异常");
		Log.error(
			"重试后仍无法确认任务点「" +
				job.title +
				"」完成，跳过并继续后续任务（" +
				(lastErr && lastErr.message) +
				"）",
		);
		await sleep(1500); // 给用户看清日志
	}

	const Runner = {
		start() {
			if (S.running) return;
			S.running = true;
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
			Panel.setStatus("已停止");
			Panel.setTask("—");
			Log.info("用户停止刷课：已终止定时器与监听，不再自动切换课时");
		},
	};

	// ========================= 10. 启动 =========================
	function main() {
		Panel.ensure();
		Log.info("脚本已加载（v0.1.0）｜点击「开始刷课」启动");
		const p = courseParams();
		const lessons = scanLessons();
		const cur = lessons.find((l) => l.isCurrent);
		Panel.setLesson(
			cur
				? lessons.indexOf(cur) + 1 + " / " + lessons.length + "　" + cur.title
				: "—",
		);
		if (store.get("autoStart", false)) {
			Log.info("自动启动已开启，2 秒后开始");
			setTimeout(() => Runner.start(), 2000);
		}
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", main);
	} else {
		main();
	}
})();
