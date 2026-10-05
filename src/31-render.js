// ========================= 13. 题目渲染器（DOM → Canvas 位图） =========================
//
// 为什么必须用位图：
//   学习通对题干/选项使用 font-cxsecret 字体做映射混淆，映射表随页面加载随机生成，
//   静态码表无法破解；只有让浏览器按当前字体真实排版再截图，才能得到可读文本。
// 实现方式：
//   克隆题目 DOM → 内联原文档的计算样式（逐字体族保真）→ 图片转 dataURL →
//   基于 Range.getClientRects() 逐行重绘到 canvas（不依赖 html2canvas，无外部依赖且布局精确）。

const QuestionRenderer = (function () {
	let host = null;
	let styleInjected = false;

	const HOST_ID = "cxap-render-host";
	const CLS = {
		root: "cxq-root",
		stem: "cxq-stem",
		opt: "cxq-opt",
		letter: "cxq-opt-letter",
		body: "cxq-opt-body",
	};

	const STYLE = `
.${CLS.root} { width: 100%; background: #fff; color: #1a1a1a;
  font-family: "Microsoft YaHei", "PingFang SC", sans-serif; font-size: 14px; line-height: 1.7; }
.${CLS.root} * { margin: 0; padding: 0; border: 0; float: none; background: transparent;
  box-sizing: border-box; max-width: 100%; }
.${CLS.stem} { margin-bottom: 9px; word-break: break-word; }
.${CLS.stem} p { display: block; }
.${CLS.stem} img { display: inline-block; vertical-align: middle; height: auto; }
.${CLS.opt} { display: flex; align-items: flex-start; margin: 6px 0; }
.${CLS.letter} { flex: 0 0 auto; margin-right: 8px; font-family: "Microsoft YaHei", sans-serif;
  font-size: 14px; line-height: 1.7; color: #1a1a1a; }
.${CLS.body} { flex: 1 1 auto; min-width: 0; word-break: break-word; }
.${CLS.body} p { display: block; }
.${CLS.body} img { display: inline-block; vertical-align: middle; height: auto; }
`;

	function ensureHost() {
		if (host && host.isConnected) return host;
		host = document.createElement("div");
		host.id = HOST_ID;
		host.style.cssText =
			"position:fixed;left:-100000px;top:0;width:" +
			CFG.renderWidth +
			"px;z-index:-2147483647;background:#fff;pointer-events:none;";
		document.body.appendChild(host);
		S.panels.push(host);
		if (!styleInjected) {
			const st = document.createElement("style");
			st.textContent = STYLE;
			document.head.appendChild(st);
			styleInjected = true;
		}
		return host;
	}

	/** 把源元素的文字相关计算样式内联到克隆元素，保证字体族（含混淆字体）与颜色一致 */
	function mirrorTextStyles(srcEl, dstEl, srcWin) {
		let cs = null;
		try {
			cs = srcWin.getComputedStyle(srcEl);
		} catch (e) {
			/* noop */
		}
		if (!cs) return;
		const s = dstEl.style;
		s.fontFamily = cs.fontFamily;
		s.fontSize = cs.fontSize;
		s.fontStyle = cs.fontStyle;
		s.fontWeight = cs.fontWeight;
		s.lineHeight = cs.lineHeight;
		s.color = cs.color;
		s.letterSpacing = cs.letterSpacing;
		s.textAlign = cs.textAlign;
		s.textDecoration = cs.textDecorationLine || cs.textDecoration;
		s.whiteSpace = "pre-wrap";
		s.verticalAlign = "baseline";
		if (srcEl.tagName === "IMG") {
			s.display = "inline-block";
			s.verticalAlign = "middle";
			s.height = "auto";
		}
	}

	/** 递归克隆子树并逐节点镜像计算样式 */
	function cloneWithStyles(srcEl, srcWin) {
		const dst = srcEl.cloneNode(false);
		mirrorTextStyles(srcEl, dst, srcWin);
		Dom.toArray(srcEl.childNodes).forEach((child) => {
			if (child.nodeType === 1) {
				dst.appendChild(cloneWithStyles(child, srcWin));
			} else if (child.nodeType === 3) {
				dst.appendChild(srcEl.ownerDocument.createTextNode(child.nodeValue));
			}
		});
		return dst;
	}

	/** 构建离屏渲染 DOM：题干 + 逐行选项 */
	async function buildDom(question) {
		const h = ensureHost();
		const srcDoc = question.doc;
		const srcWin = srcDoc.defaultView;

		const root = document.createElement("div");
		root.className = CLS.root;

		// 题干
		const stemWrap = document.createElement("div");
		stemWrap.className = CLS.stem;
		if (question.stemEl) {
			stemWrap.appendChild(cloneWithStyles(question.stemEl, srcWin));
		} else {
			const fallback = document.createElement("div");
			fallback.textContent = question.stemText || "（题干读取失败）";
			stemWrap.appendChild(fallback);
		}
		root.appendChild(stemWrap);

		// 选项（重建为整洁的单行结构，避免原页面浮动布局带来的不确定性）
		question.options.forEach((opt) => {
			const row = document.createElement("div");
			row.className = CLS.opt;
			const letter = document.createElement("span");
			letter.className = CLS.letter;
			letter.textContent = opt.letter + ".";
			row.appendChild(letter);
			const body = document.createElement("div");
			body.className = CLS.body;
			body.appendChild(cloneWithStyles(opt.bodyEl, srcWin));
			row.appendChild(body);
			root.appendChild(row);
		});

		h.appendChild(root);

		// 图片转 dataURL，避免污染画布（同时绕过混合内容限制）
		await inlineImages(root);
		await ImageUtils.waitImages(root, 10000);

		return root;
	}

	/** 把容器内所有 img 的 src 换成 dataURL */
	async function inlineImages(root) {
		const imgs = Dom.toArray(root.querySelectorAll("img"));
		await Promise.all(
			imgs.map(async (img) => {
				const raw = img.getAttribute("data-original") || img.getAttribute("src") || "";
				if (!raw || /^data:/i.test(raw)) return;
				const dataUrl = await ImageUtils.fetchAsDataUrl(raw);
				if (dataUrl) {
					img.setAttribute("src", dataUrl);
				} else {
					// 拉取失败：留占位，避免整题渲染失败
					img.removeAttribute("src");
					img.style.cssText +=
						"display:inline-block;min-width:120px;height:22px;background:#eee;border:1px dashed #bbb;";
					img.setAttribute("alt", "[图片加载失败]");
					const ph = document.createElement("span");
					ph.textContent = "[图片加载失败]";
					ph.style.color = "#c0392b";
					img.replaceWith(ph);
				}
			}),
		);
	}

	/** 计算元素（或 DOMRect）相对基准矩形的偏移 */
	function relRect(el, base) {
		const r =
			typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : el;
		return {
			x: r.left - base.left,
			y: r.top - base.top,
			w: r.width,
			h: r.height,
		};
	}

	/** 单行文本：取文本节点每行的字符区间与几何 */
	function layoutTextNode(node) {
		const text = node.nodeValue || "";
		if (!text.trim()) return [];
		const doc = node.ownerDocument;
		const range = doc.createRange();
		range.selectNodeContents(node);
		const rects = Dom.toArray(range.getClientRects()).filter(
			(r) => r.height > 0 && (r.width > 0 || r.height > 0),
		);
		if (!rects.length) return [];
		if (rects.length === 1) {
			return [{ text: text.replace(/\s+/g, " "), rect: rects[0] }];
		}
		// 多行：二分定位每行覆盖的字符区间
		const lines = [];
		let start = 0;
		for (let i = 0; i < rects.length; i++) {
			if (start >= text.length) break;
			const targetTop = rects[i].top;
			let lo = start + 1,
				hi = text.length,
				best = start + 1;
			while (lo <= hi) {
				const mid = (lo + hi) >> 1;
				range.setStart(node, start);
				range.setEnd(node, mid);
				const rs = Dom.toArray(range.getClientRects()).filter((r) => r.height > 0);
				const ok = !rs.length || Math.abs(rs[rs.length - 1].top - targetTop) < 2;
				if (ok) {
					best = mid;
					lo = mid + 1;
				} else {
					hi = mid - 1;
				}
			}
			lines.push({ text: text.slice(start, best), rect: rects[i] });
			start = best;
		}
		if (start < text.length) {
			lines.push({ text: text.slice(start), rect: rects[rects.length - 1] });
		}
		return lines;
	}

	/** 递归收集绘制指令（保持 DOM 顺序，后绘制者覆盖先绘制者） */
	function collect(container, base) {
		const items = [];
		const srcWin = container.ownerDocument.defaultView;

		function walk(el) {
			const cs = srcWin.getComputedStyle(el);
			const bg = cs.backgroundColor;
			if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
				const r = relRect(el, base);
				if (r.w > 0 && r.h > 0) items.push({ type: "rect", rect: r, color: bg });
			}
			Dom.toArray(el.childNodes).forEach((child) => {
				if (child.nodeType === 3) {
					layoutTextNode(child).forEach((ln) => {
						if (!ln.text || !ln.text.trim()) return;
						const r = relRect(ln.rect, base);
						items.push({
							type: "text",
							text: ln.text,
							rect: r,
							color: cs.color,
							font: buildFont(cs),
						});
					});
				} else if (child.nodeType === 1) {
					if (child.tagName === "IMG") {
						const r = relRect(child, base);
						if (r.w > 0 && r.h > 0 && child.complete && child.naturalWidth > 0)
							items.push({ type: "img", el: child, rect: r });
						return;
					}
					if (child.tagName === "BR") return;
					walk(child);
				}
			});
		}
		walk(container);
		return items;
	}

	function buildFont(cs) {
		const style = cs.fontStyle && cs.fontStyle !== "normal" ? cs.fontStyle + " " : "";
		const weight =
			cs.fontWeight && cs.fontWeight !== "400" && cs.fontWeight !== "normal"
				? cs.fontWeight + " "
				: "";
		return style + weight + cs.fontSize + " " + cs.fontFamily;
	}

	/** 把收集到的指令绘制到 canvas */
	function paint(items, width, height) {
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.ceil(width));
		canvas.height = Math.max(1, Math.ceil(height));
		const ctx = canvas.getContext("2d");
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.textBaseline = "alphabetic";

		for (const it of items) {
			try {
				if (it.type === "rect") {
					ctx.fillStyle = it.color;
					ctx.fillRect(it.rect.x, it.rect.y, it.rect.w, it.rect.h);
				} else if (it.type === "img") {
					ctx.drawImage(it.el, it.rect.x, it.rect.y, it.rect.w, it.rect.h);
				} else if (it.type === "text") {
					ctx.font = it.font;
					ctx.fillStyle = it.color;
					const m = ctx.measureText(it.text);
					const asc = m.actualBoundingBoxAscent || 0;
					const desc = m.actualBoundingBoxDescent || 0;
					const boxH = it.rect.h;
					const baseline =
						it.rect.y +
						(boxH - (asc + desc)) / 2 +
						asc; /* 按字形实际高度垂直居中对齐 */
					ctx.fillText(it.text, it.rect.x, baseline);
				}
			} catch (e) {
				/* 单条指令失败不影响整图 */
			}
		}
		return canvas;
	}

	/**
	 * 原生栅格化：把真实 DOM 交给浏览器排版引擎渲染成位图。
	 *
	 * 与 canvas 逐行重绘相比，这里用的是浏览器自己的文本排版（换行、公式、表格、MathML 全部与页面一致），
	 * 且把混淆字体的 @font-face 以 data: URL 直接嵌进 SVG，
	 * 不依赖任何字体注册流程 —— 从机制上杜绝「字体未生效→渲染出密文」这一类问题。
	 */
	async function captureNative(question, root) {
		const width = Math.max(1, Math.round(root.getBoundingClientRect().width));
		const height = Math.max(1, Math.round(root.getBoundingClientRect().height));
		// 固定宽度，保证 SVG 内布局与测量一致
		root.style.width = width + "px";

		const xml = new XMLSerializer().serializeToString(root);
		const fontCss = buildFontCss(question.doc);
		const svg =
			'<svg xmlns="http://www.w3.org/2000/svg" width="' +
			width +
			'" height="' +
			height +
			'" viewBox="0 0 ' +
			width +
			" " +
			height +
			'">' +
			"<style type=\"text/css\"><![CDATA[" +
			STYLE +
			"\n" +
			fontCss +
			"]]></style>" +
			'<foreignObject x="0" y="0" width="' +
			width +
			'" height="' +
			height +
			'">' +
			xml +
			"</foreignObject></svg>";

		const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
		const img = await loadImage(url, CFG.renderTimeout);
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, width, height);
		ctx.drawImage(img, 0, 0);
		return canvas;
	}

	/** 生成嵌入 SVG 的 @font-face 声明（含文档中所有字体，保证排版保真） */
	function buildFontCss(doc) {
		const faces = FontTools.collectFaces(doc);
		const out = [];
		faces.forEach((src, family) => {
			const abs = /^data:/i.test(src) ? src : Dom.absUrl(src, doc);
			out.push(
				'@font-face{font-family:"' +
					family.replace(/"/g, "") +
					'";src:url("' +
					abs +
					'");}',
			);
		});
		return out.join("\n");
	}

	function loadImage(url, timeout) {
		return withTimeout(
			new Promise((resolve, reject) => {
				const img = new Image();
				img.onload = () => resolve(img);
				img.onerror = () => reject(new Error("SVG 图片解码失败"));
				img.src = url;
			}),
			timeout,
			"原生栅格化",
		);
	}

	/** 画布是否有内容（避免把空白图发给模型） */
	function hasInk(canvas) {
		try {
			const ctx = canvas.getContext("2d", { willReadFrequently: true });
			const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
			let ink = 0;
			for (let i = 0; i < d.length; i += 4) {
				if (d[i] < 220 || d[i + 1] < 220 || d[i + 2] < 220) {
					if (++ink > 60) return true;
				}
			}
			return false;
		} catch (e) {
			return true; // 读取失败时不阻断流程
		}
	}

	/**
	 * 探针渲染：用与正式渲染完全相同的管线（native=SVG 内嵌字体 / canvas=顶层注册字体）
	 * 渲染一段密文字符，再与系统字体渲染结果比较，判断混淆字体是否真的生效。
	 */
	async function probeEffective(question, probeText, method) {
		const doc = question.doc;
		const family = FontTools.resolveSecretFamily(doc);
		if (!family) return true;

		if (method === "canvas") {
			return FontTools.isFontEffective('"' + family + '"', probeText);
		}

		// native：走 SVG + foreignObject，验证内嵌字体确实参与排版
		try {
			const w = 300;
			const h = 60;
			const inner =
				'<div xmlns="http://www.w3.org/1999/xhtml" style="margin:0;padding:0;' +
				"width:" +
				w +
				"px;height:" +
				h +
				"px;background:#fff;color:#000;font-size:40px;line-height:60px;" +
				"white-space:nowrap;font-family:'" +
				family.replace(/'/g, "") +
				"';\">" +
				escapeXml(probeText) +
				"</div>";
			const svg =
				'<svg xmlns="http://www.w3.org/2000/svg" width="' +
				w +
				'" height="' +
				h +
				'"><style type="text/css"><![CDATA[' +
				buildFontCss(doc) +
				"]]></style>" +
				'<foreignObject x="0" y="0" width="' +
				w +
				'" height="' +
				h +
				'">' +
				inner +
				"</foreignObject></svg>";
			const img = await loadImage(
				"data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg),
				8000,
			);
			const a = document.createElement("canvas");
			a.width = w;
			a.height = h;
			const actx = a.getContext("2d", { willReadFrequently: true });
			actx.fillStyle = "#fff";
			actx.fillRect(0, 0, w, h);
			actx.drawImage(img, 0, 0);
			const da = actx.getImageData(0, 0, w, h).data;

			const sys = FontTools._probeCanvas('"Microsoft YaHei"', probeText);
			let diff = 0;
			for (let i = 0; i < da.length; i += 4) {
				if (Math.abs(da[i] - sys[i]) > 60) diff++;
			}
			// 只要渲染出的字形与系统字体有显著差异，就说明混淆字体确实生效
			return diff > 30;
		} catch (e) {
			return false;
		}
	}

	function escapeXml(s) {
		return String(s)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;");
	}

	/**
	 * 渲染正确性自检（防止把「混淆后的密文」当成题目发给模型）。
	 *
	 * 原理：混淆字体只覆盖有限码点（字体 cmap），这些码点就是被替换掉的字符。
	 *  - 题目文本里没有任何 cmap 覆盖的字符 → 不存在混淆，渲染必然忠实
	 *  - 存在 → 用这些字符做探针，比较「混淆字体渲染」与「系统字体渲染」的位图；
	 *    两者一致说明字体没生效（渲染出的会是密文），判为失败
	 */
	async function checkObfuscationResolved(question, canvas, method) {
		const doc = question.doc;
		const family = FontTools.resolveSecretFamily(doc);
		if (!family) return { ok: true, reason: "no-secret-font" };

		const text = collectText(question);
		const ciphers = FontTools.cipherCharsIn(doc, text);
		if (!ciphers.length) return { ok: true, reason: "no-obfuscated-chars" };

		const probe = ciphers.slice(0, 8).join("");
		const effective = await probeEffective(question, probe, method);
		if (!effective) {
			return { ok: false, reason: "font-not-applied", probe };
		}
		if (canvas && !hasInk(canvas)) {
			return { ok: false, reason: "empty-render", probe };
		}
		return { ok: true, reason: "ok", ciphers: ciphers.length };
	}

	/** 收集题目全部可见文本（题干 + 选项） */
	function collectText(question) {
		let s = question.stemText || "";
		if (question.stemEl) s += " " + Dom.normText(question.stemEl.textContent);
		(question.options || []).forEach((o) => {
			s += " " + o.text;
			try {
				s += " " + Dom.normText(o.bodyEl.textContent);
			} catch (e) {
				/* noop */
			}
		});
		return s;
	}

	/**
	 * 渲染一道题 → dataURL 数组（超长题干自动切分）。
	 * 返回 { images, width, height, slices, method, ciphers }
	 */
	async function render(question) {
		let root = null;
		let method = "native";
		let canvas = null;
		try {
			// 顶层文档也注册一份混淆字体：既是 canvas 兜底路径的前提，也是自检探针的依据
			const reg = await FontTools.registerSecretFont(question.doc, document);
			if (!reg) Log.warn("混淆字体未能注册到顶层文档，将主要依赖原生栅格化路径");

			root = await withTimeout(buildDom(question), CFG.renderTimeout, "题目构建");

			try {
				canvas = await captureNative(question, root);
			} catch (e) {
				Log.warn("原生栅格化失败（" + e.message + "），回退到 canvas 渲染");
				method = "canvas";
				const base = root.getBoundingClientRect();
				const items = collect(root, base);
				canvas = paint(items, base.width, base.height);
			}

			// 强制自检：字体未生效则不予发送（宁可不作答，也不能把密文喂给模型）
			const check = await checkObfuscationResolved(question, canvas, method);
			if (!check.ok) {
				throw new Error(
					check.reason === "empty-render"
						? "渲染结果为空白"
						: "字体混淆未还原（探针字符「" +
							check.probe +
							"」渲染后未发生变化），图像会显示密文，已拒绝发送",
				);
			}

			const scaled = ImageUtils.scaleCanvas(canvas, CFG.imageMaxWidth);
			const slices = ImageUtils.sliceCanvas(
				scaled,
				CFG.renderMaxHeight,
				CFG.renderTileOverlap,
			);
			return {
				images: slices.map((c) => ImageUtils.canvasToDataUrl(c, "png")),
				width: scaled.width,
				height: scaled.height,
				slices: slices.length,
				method,
				ciphers: check.ciphers || 0,
			};
		} finally {
			if (root && root.parentNode) root.parentNode.removeChild(root);
		}
	}

	return { render, ensureHost, collectText, checkObfuscationResolved };
})();
