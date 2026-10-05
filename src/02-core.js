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
