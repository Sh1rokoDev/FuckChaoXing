// ========================= 12. 图片工具（跨域下载 / 尺寸处理） =========================

const ImageUtils = {
	/** 通过 GM_xmlhttpRequest 取二进制（扩展层发起，不受页面 CORS 限制） */
	_fetchBinaryGM(url) {
		return new Promise((resolve, reject) => {
			if (typeof GM_xmlhttpRequest !== "function")
				return reject(new Error("GM_xmlhttpRequest 不可用"));
			GM_xmlhttpRequest({
				method: "GET",
				url,
				responseType: "arraybuffer",
				timeout: 30000,
				onload(res) {
					if (res.status >= 200 && res.status < 300 && res.response)
						resolve({ buf: res.response, type: res.responseHeaders });
					else reject(new Error("HTTP " + res.status));
				},
				onerror: () => reject(new Error("网络错误")),
				ontimeout: () => reject(new Error("请求超时")),
			});
		});
	},

	/** 通过页面 fetch 取二进制（同源或服务端已放行 CORS 时可用） */
	async _fetchBinaryPage(url) {
		const res = await fetch(url, { credentials: "omit", mode: "cors" });
		if (!res.ok) throw new Error("HTTP " + res.status);
		return { buf: await res.arrayBuffer(), type: res.headers.get("content-type") };
	},

	_mimeOf(url, type) {
		if (type && /^image\//i.test(type)) return type.split(";")[0];
		const m = String(url).match(/\.(png|jpe?g|gif|webp|bmp|svg)(?:\?|#|$)/i);
		if (!m) return "image/png";
		const ext = m[1].toLowerCase();
		if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
		if (ext === "svg") return "image/svg+xml";
		return "image/" + ext;
	},

	/** ArrayBuffer → base64 */
	_b64(buf) {
		const bytes = new Uint8Array(buf);
		let bin = "";
		const chunk = 0x8000;
		for (let i = 0; i < bytes.length; i += chunk) {
			bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
		}
		return btoa(bin);
	},

	_cache: new Map(), // url → dataUrl

	/** 拉取图片并转换为 data URL（供 canvas 使用，避免污染画布） */
	async fetchAsDataUrl(rawUrl) {
		const url = Dom.httpsUrl(rawUrl);
		if (!url) return null;
		if (this._cache.has(url)) return this._cache.get(url);
		let out = null;
		try {
			const r = await this._fetchBinaryGM(url);
			out = "data:" + this._mimeOf(url, r.type) + ";base64," + this._b64(r.buf);
		} catch (e) {
			try {
				const r2 = await this._fetchBinaryPage(url);
				out = "data:" + this._mimeOf(url, r2.type) + ";base64," + this._b64(r2.buf);
			} catch (e2) {
				out = null;
			}
		}
		this._cache.set(url, out);
		return out;
	},

	/** 等待容器内所有图片加载完成（含失败） */
	async waitImages(container, timeout) {
		const imgs = Dom.toArray(container.querySelectorAll("img"));
		if (!imgs.length) return;
		const wait = (img) =>
			new Promise((resolve) => {
				if (img.complete) return resolve();
				const done = () => {
					img.removeEventListener("load", done);
					img.removeEventListener("error", done);
					resolve();
				};
				img.addEventListener("load", done);
				img.addEventListener("error", done);
			});
		try {
			await withTimeout(Promise.all(imgs.map(wait)), timeout || 8000, "图片加载");
		} catch (e) {
			/* 超时也继续，缺图不影响其余内容 */
		}
	},

	/** 把 canvas 缩放到目标宽度并降采样（返回新 canvas） */
	scaleCanvas(src, maxWidth) {
		if (!maxWidth || src.width <= maxWidth) return src;
		const ratio = maxWidth / src.width;
		const out = document.createElement("canvas");
		out.width = Math.round(src.width * ratio);
		out.height = Math.round(src.height * ratio);
		const ctx = out.getContext("2d");
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = "high";
		ctx.fillStyle = "#fff";
		ctx.fillRect(0, 0, out.width, out.height);
		ctx.drawImage(src, 0, 0, out.width, out.height);
		return out;
	},

	/** canvas → PNG dataURL（无损原图，题目文字与公式不失真） */
	canvasToDataUrl(canvas) {
		return canvas.toDataURL("image/png");
	},

	/** 纵向切分长图（含重叠），返回 dataURL 数组 */
	sliceCanvas(canvas, maxHeight, overlap) {
		const max = maxHeight || CFG.renderMaxHeight;
		if (canvas.height <= max) return [canvas];
		const out = [];
		const step = Math.max(64, max - (overlap || CFG.renderTileOverlap));
		for (let y = 0; y < canvas.height; y += step) {
			const h = Math.min(max, canvas.height - y);
			if (h < 40) break;
			const c = document.createElement("canvas");
			c.width = canvas.width;
			c.height = h;
			const ctx = c.getContext("2d");
			ctx.fillStyle = "#fff";
			ctx.fillRect(0, 0, c.width, c.height);
			ctx.drawImage(canvas, 0, -y);
			out.push(c);
			if (y + h >= canvas.height) break;
		}
		return out;
	},
};
