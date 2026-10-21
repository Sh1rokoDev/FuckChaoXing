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
