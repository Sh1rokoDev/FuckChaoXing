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
