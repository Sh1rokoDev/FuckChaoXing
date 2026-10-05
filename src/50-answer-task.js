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
