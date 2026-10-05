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
