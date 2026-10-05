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
		const wantJson = opts.jsonMode != null ? opts.jsonMode : cfg.jsonMode !== false;
		const maxTokens = opts.maxTokens || cfg.maxTokens || 2048;

		// 环境预检：混合内容 / 跨域等不可恢复问题直接失败，避免无意义的重试等待
		const pf = preflight(url);
		if (!pf.ok) {
			const err = new Error(pf.reason);
			err.fatal = true;
			throw err;
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
				// JSON 模式不被支持时降级重试一次
				if (
					res.status >= 400 &&
					wantJson &&
					/json|response_format|format/i.test(res.text) &&
					/not support|unsupported|invalid|unrecognized|unknown/i.test(res.text)
				) {
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

	return { chat, extractJson, estimatePayloadKB, endpoint, hasGM, preflight };
})();
