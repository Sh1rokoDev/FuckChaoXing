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
