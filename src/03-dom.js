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
