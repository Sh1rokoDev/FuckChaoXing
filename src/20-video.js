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
