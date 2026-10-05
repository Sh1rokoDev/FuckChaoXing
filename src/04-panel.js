// ========================= 7. 悬浮控制面板（Shadow DOM 隔离） =========================

const Panel = (function () {
	let host = null,
		root = null,
		el = {};

	const HTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; margin: 0; padding: 0;
            font-family: "Microsoft YaHei", "PingFang SC", -apple-system, sans-serif; }
        .panel { width: 620px; background: #fff; border-radius: 14px; overflow: hidden;
                 box-shadow: 0 10px 34px rgba(15,23,42,.22), 0 2px 8px rgba(15,23,42,.08);
                 font-size: 11.5px; color: #0f172a; position: relative; }

        /* 标题栏 */
        .titlebar { background: linear-gradient(120deg, #4f46e5, #6366f1 55%, #818cf8);
                    color: #fff; padding: 10px 13px; display: flex; align-items: center;
                    gap: 9px; cursor: move; user-select: none; }
        .titlebar .brand { width: 8px; height: 8px; border-radius: 50%; background: #a5b4fc;
                           box-shadow: 0 0 0 3px rgba(255,255,255,.22); flex: 0 0 auto; }
        .titlebar .t { font-weight: 650; font-size: 12.5px; letter-spacing: .3px; flex: 1; }
        .titlebar .ibtn { width: 22px; height: 22px; border-radius: 6px; display: flex;
                          align-items: center; justify-content: center; cursor: pointer;
                          font-size: 13px; line-height: 1; opacity: .9; transition: all .15s; }
        .titlebar .ibtn:hover { background: rgba(255,255,255,.2); opacity: 1; }

        /* 两栏布局：左控制区 + 右日志区 */
        .body { display: flex; align-items: stretch; height: 402px; }
        .col-left { width: 298px; flex: 0 0 auto; padding: 11px 12px 12px;
                    display: flex; flex-direction: column; border-right: 1px solid #eef2f7; }
        .col-right { flex: 1 1 auto; min-width: 0; padding: 11px 12px 12px;
                     display: flex; flex-direction: column; }

        /* 状态区 */
        .statline { display: flex; align-items: center; gap: 7px; margin-bottom: 2px; }
        .pill { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px;
                border-radius: 999px; font-size: 10.5px; font-weight: 650; flex: 0 0 auto; }
        .pill i { width: 6px; height: 6px; border-radius: 50%; background: currentColor;
                  display: block; }
        .p-idle { background: #f1f5f9; color: #64748b; }
        .p-run { background: #ecfdf5; color: #047857; }
        .p-wait { background: #fffbeb; color: #b45309; }
        .p-err { background: #fef2f2; color: #dc2626; }
        .p-done { background: #eef2ff; color: #4338ca; }
        .p-run i { animation: pulse 1.5s ease-in-out infinite; }
        @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .3 } }
        .curtask { flex: 1; text-align: right; color: #94a3b8; font-size: 11px; overflow: hidden;
                   text-overflow: ellipsis; white-space: nowrap; }

        /* 进度 */
        .prog { margin-top: 7px; }
        .prow { display: flex; align-items: center; gap: 7px; margin: 5px 0; }
        .prow .lbl { color: #64748b; font-size: 11px; width: 62px; flex: 0 0 auto; }
        .bar { flex: 1; height: 4px; border-radius: 999px; background: #eef2f7; overflow: hidden; }
        .bar span { display: block; height: 100%; width: 0%; border-radius: 999px;
                    transition: width .3s ease; }
        .bar.v span { background: linear-gradient(90deg, #34d399, #10b981); }
        .bar.a span { background: linear-gradient(90deg, #818cf8, #6366f1); }
        .cnt { font-variant-numeric: tabular-nums; color: #475569; font-weight: 650;
               font-size: 10.5px; width: 46px; text-align: right; flex: 0 0 auto; }
        .lesson { margin-top: 6px; color: #94a3b8; font-size: 10.5px; overflow: hidden;
                  text-overflow: ellipsis; white-space: nowrap; }

        /* 主按钮 */
        .mainbtn { width: 100%; margin-top: 9px; padding: 8px 0; border: 0; border-radius: 9px;
                   cursor: pointer; font-size: 12.5px; font-weight: 650; color: #fff;
                   letter-spacing: .3px; transition: all .18s; }
        .mainbtn.start { background: linear-gradient(120deg, #4f46e5, #6366f1);
                         box-shadow: 0 4px 14px rgba(79,70,229,.32); }
        .mainbtn.start:hover { filter: brightness(1.06); }
        .mainbtn.stop { background: linear-gradient(120deg, #ef4444, #f87171);
                        box-shadow: 0 4px 14px rgba(239,68,68,.3); }
        .mainbtn.stop:hover { filter: brightness(1.06); }

        /* 设置区 */
        .sect { display: flex; align-items: center; gap: 6px;
                margin: 10px 0 6px; }
        .sect .st { font-weight: 650; color: #334155; font-size: 11.5px;
                    display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
        .sect .st::before { content: ""; width: 3px; height: 11px; border-radius: 2px;
                            background: #4f46e5; }
        .sect .lnk { color: #4f46e5; cursor: pointer; font-size: 11px; font-weight: 600;
                     flex: 0 0 auto; }
        .sect .lnk:hover { text-decoration: underline; }
        .sect .llmname { flex: 1 1 auto; min-width: 0; overflow: hidden;
                         text-overflow: ellipsis; white-space: nowrap;
                         color: #94a3b8; font-size: 11px; text-align: right; }
        .sect .spacer { flex: 1 1 auto; }
        .tag { display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 10px;
               line-height: 15px; background: #eef2ff; color: #4338ca; font-weight: 600; }
        .tag.warn { background: #fef2f2; color: #dc2626; }

        /* 开关 */
        .switches { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 10px; }
        .sw { display: flex; align-items: center; justify-content: space-between; gap: 7px;
              cursor: pointer; user-select: none; color: #475569; font-size: 11px;
              padding: 1px 0; }
        .sw input { position: absolute; opacity: 0; pointer-events: none; }
        .sw .track { width: 29px; height: 16px; border-radius: 999px; background: #e2e8f0;
                     flex: 0 0 auto; position: relative; transition: background .2s; }
        .sw .track::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px;
                            height: 12px; border-radius: 50%; background: #fff;
                            box-shadow: 0 1px 3px rgba(15,23,42,.28); transition: transform .2s; }
        .sw input:checked + .track { background: #4f46e5; }
        .sw input:checked + .track::after { transform: translateX(13px); }
        .sw:hover .track { filter: brightness(.97); }

        /* 题型 chip */
        .chips { display: flex; gap: 6px; flex-wrap: wrap; }
        .chip { padding: 3px 10px; border-radius: 999px; border: 1px solid #e2e8f0;
                background: #f8fafc; color: #64748b; font-size: 11px; cursor: pointer;
                user-select: none; transition: all .15s; font-weight: 500; }
        .chip:hover { border-color: #c7d2fe; color: #4f46e5; }
        .chip.on { background: #4f46e5; border-color: #4f46e5; color: #fff;
                   box-shadow: 0 2px 8px rgba(79,70,229,.28); font-weight: 600; }
        .chip.dim { opacity: .45; cursor: not-allowed; }

        /* 日志（卡片流） */
        .loghd { display: flex; align-items: center; justify-content: space-between;
                 margin-bottom: 6px; flex: 0 0 auto; }
        .loghd .st { font-weight: 650; color: #334155; font-size: 11px;
                     display: flex; align-items: center; gap: 6px; }
        .loghd .st::before { content: ""; width: 3px; height: 11px; border-radius: 2px;
                             background: #4f46e5; }
        .loghd .cnt { color: #94a3b8; font-size: 10px; }

        .log { flex: 1 1 auto; min-height: 0; overflow-y: auto; background: #f8fafc;
               border: 1px solid #eef2f7; border-radius: 9px; padding: 8px;
               display: flex; flex-direction: column; gap: 7px; }
        .log::-webkit-scrollbar { width: 6px; }
        .log::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
        .log::-webkit-scrollbar-track { background: transparent; }

        /* 卡片 */
        .card { background: #fff; border: 1px solid #e8edf5; border-radius: 8px;
                overflow: hidden; flex: 0 0 auto; }
        .card.sys { background: #fbfcfe; border-color: #eef2f7; }
        .card .chd { display: flex; align-items: center; gap: 6px; padding: 5px 8px;
                     border-bottom: 1px solid #f1f5f9; }
        .card.sys .chd { border-bottom-color: #eef2f7; }
        .card .chd .bar { width: 3px; height: 11px; border-radius: 2px; flex: 0 0 auto; }
        .card.sys .chd .bar { background: #94a3b8; }
        .card.video .chd .bar { background: #10b981; }
        .card.job .chd .bar { background: #6366f1; }
        .card.q .chd .bar { background: #8b5cf6; }
        .card .chd .ctitle { font-weight: 650; color: #334155; font-size: 10.5px;
                             flex: 1 1 auto; min-width: 0; overflow: hidden;
                             text-overflow: ellipsis; white-space: nowrap; }
        .card .chd .cbadge { font-size: 9.5px; font-weight: 650; padding: 1px 6px;
                             border-radius: 999px; background: #f1f5f9; color: #64748b;
                             flex: 0 0 auto; }
        .card .chd .cbadge.ok { background: #ecfdf5; color: #047857; }
        .card .chd .cbadge.err { background: #fef2f2; color: #dc2626; }
        .card .chd .cbadge.run { background: #eef2ff; color: #4338ca; }
        .card .cbody { padding: 6px 8px 7px; }
        .card .cbody:empty { display: none; }

        .cline { display: flex; gap: 6px; line-height: 1.5; font-size: 10.5px;
                 font-family: "Cascadia Mono", Consolas, monospace;
                 word-break: break-all; }
        .cline .ts { color: #b6c2d2; flex: 0 0 auto; font-size: 9.5px; padding-top: 1px; }
        .cline .tx { flex: 1 1 auto; min-width: 0; white-space: pre-wrap; color: #64748b; }
        .cline.INFO .tx { color: #15803d; }
        .cline.SKIP .tx { color: #2563eb; }
        .cline.WARN .tx { color: #b45309; }
        .cline.ERROR .tx { color: #dc2626; }
        .cline.OK .tx { color: #0f766e; font-weight: 600; }
        .cline.LLM .tx { color: #7c3aed; }
        .cline.PICK .tx { color: #0e7490; }

        /* 题目缩略图（点击弹出查看） */
        .thumb { display: flex; gap: 7px; align-items: center; margin-bottom: 5px;
                 padding: 5px; background: #f8fafc; border: 1px dashed #dbe3ee;
                 border-radius: 6px; cursor: pointer; transition: all .15s; }
        .thumb:hover { background: #eef2ff; border-color: #c7d2fe; }
        .thumb img { width: 74px; height: 40px; object-fit: cover; object-position: top left;
                     border-radius: 4px; border: 1px solid #e2e8f0; background: #fff;
                     flex: 0 0 auto; }
        .thumb .tt { flex: 1 1 auto; min-width: 0; color: #4f46e5; font-size: 10.5px;
                     font-weight: 600; line-height: 1.4; }
        .thumb .tt small { display: block; color: #94a3b8; font-weight: 400;
                           font-size: 9.5px; margin-top: 1px; }

        /* 图片查看弹窗 */
        .imgmask { position: absolute; inset: 0; background: rgba(15,23,42,.72);
                   display: flex; align-items: center; justify-content: center;
                   z-index: 100; padding: 18px; }
        .imgmask .box { background: #fff; border-radius: 10px; overflow: hidden;
                        max-width: 100%; max-height: 100%; display: flex;
                        flex-direction: column; box-shadow: 0 18px 48px rgba(0,0,0,.4); }
        .imgmask .bh { display: flex; align-items: center; gap: 8px; padding: 7px 10px;
                       border-bottom: 1px solid #eef2f7; }
        .imgmask .bh .bt { font-weight: 650; color: #334155; font-size: 11px;
                           flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis;
                           white-space: nowrap; }
        .imgmask .bh .bx { cursor: pointer; color: #94a3b8; font-size: 16px; line-height: 1;
                           padding: 0 3px; border-radius: 5px; }
        .imgmask .bh .bx:hover { background: #fef2f2; color: #dc2626; }
        .imgmask .bb { overflow: auto; padding: 8px; background: #fff; }
        .imgmask .bb img { display: block; width: 100%; background: #fff; }
      </style>
      <div class="panel">
        <div class="titlebar" id="titlebar">
          <span class="brand"></span>
          <span class="t">学习通任务点助手</span>
          <span class="ibtn" id="btnmin" title="折叠">—</span>
        </div>
        <div class="body" id="body">
          <div class="col-left">
            <div class="statline">
              <span class="pill p-idle" id="vstatus"><i></i>未启动</span>
              <span class="curtask" id="vcur">—</span>
            </div>
            <div class="prog">
              <div class="prow">
                <span class="lbl">视频任务点</span>
                <span class="bar v"><span id="barv"></span></span>
                <span class="cnt" id="vtask">0 / 0</span>
              </div>
              <div class="prow">
                <span class="lbl">答题任务点</span>
                <span class="bar a"><span id="bara"></span></span>
                <span class="cnt" id="vanswer">0 / 0</span>
              </div>
              <div class="lesson" id="vlesson">—</div>
            </div>
            <button class="mainbtn start" id="btnstart">开始刷课</button>

            <div class="sect"><span class="st">运行设置</span></div>
            <div class="switches">
              <label class="sw">静音播放<input type="checkbox" id="optmute"><span class="track"></span></label>
              <label class="sw">自动答题<input type="checkbox" id="optanswer"><span class="track"></span></label>
              <label class="sw">自动暂存<input type="checkbox" id="opttempsave"><span class="track"></span></label>
              <label class="sw">跳过已作答<input type="checkbox" id="optskipfilled"><span class="track"></span></label>
            </div>

            <div class="sect">
              <span class="st">作答题型</span>
            </div>
            <div class="chips" id="typechips">
              <span class="chip on" data-type="单选">单选题</span>
              <span class="chip on" data-type="多选">多选题</span>
              <span class="chip on" data-type="判断">判断题</span>
            </div>

            <div class="sect">
              <span class="st">模型</span>
              <span class="tag" id="tagllm">未配置</span>
              <span class="llmname" id="llmmodel">—</span>
              <span class="lnk" id="btnllm2">配置…</span>
            </div>
          </div>
          <div class="col-right">
            <div class="loghd">
              <span class="st">运行日志</span>
              <span class="cnt" id="logcnt"></span>
            </div>
            <div class="log" id="vlog"></div>
          </div>
        </div>
        <div class="imgmask" id="imgmask" style="display:none">
          <div class="box">
            <div class="bh">
              <span class="bt" id="imgtitle">题目图片</span>
              <span class="bx" id="imgclose" title="关闭">×</span>
            </div>
            <div class="bb"><img id="imgfull" alt="题目图片"></div>
          </div>
        </div>
      </div>`;

	function ensure() {
		if (host && host.isConnected) {
			refreshBadges();
			return;
		}
		host = document.createElement("div");
		host.id = "cxap-panel-host";
		host.style.cssText = "position:fixed;z-index:2147483000;top:70px;right:16px;";
		root = host.attachShadow({ mode: "open" });
		root.innerHTML = HTML;
		document.body.appendChild(host);
		S.panels.push(host);

		el = {
			status: root.getElementById("vstatus"),
			lesson: root.getElementById("vlesson"),
			task: root.getElementById("vtask"),
			answer: root.getElementById("vanswer"),
			barV: root.getElementById("barv"),
			barA: root.getElementById("bara"),
			cur: root.getElementById("vcur"),
			log: root.getElementById("vlog"),
			logCnt: root.getElementById("logcnt"),
			imgmask: root.getElementById("imgmask"),
			imgFull: root.getElementById("imgfull"),
			imgTitle: root.getElementById("imgtitle"),
			btnStart: root.getElementById("btnstart"),
			optMute: root.getElementById("optmute"),
			optAnswer: root.getElementById("optanswer"),
			optTempSave: root.getElementById("opttempsave"),
			optSkipFilled: root.getElementById("optskipfilled"),
			chips: root.getElementById("typechips"),
			tagLlm: root.getElementById("tagllm"),
			llmModel: root.getElementById("llmmodel"),
			titlebar: root.getElementById("titlebar"),
			body: root.getElementById("body"),
			btnMin: root.getElementById("btnmin"),
		};

		const ans = store.config("answer", ANSWER_DEFAULTS);
		el.optMute.checked = !!store.get("mute", false);
		el.optAnswer.checked = !!ans.enabled;
		el.optTempSave.checked = !!ans.autoTempSave;
		el.optSkipFilled.checked = !!ans.skipFilled;

		el.optMute.addEventListener("change", () => store.set("mute", el.optMute.checked));
		el.optAnswer.addEventListener("change", () => {
			patchAnswer({ enabled: el.optAnswer.checked });
			refreshBadges();
		});
		el.optTempSave.addEventListener("change", () =>
			patchAnswer({ autoTempSave: el.optTempSave.checked }),
		);
		el.optSkipFilled.addEventListener("change", () =>
			patchAnswer({ skipFilled: el.optSkipFilled.checked }),
		);

		// 题型 chip
		el.chips.addEventListener("click", (e) => {
			const chip = e.target.closest(".chip");
			if (!chip) return;
			const type = chip.getAttribute("data-type");
			const cur = store.config("answer", ANSWER_DEFAULTS).types || {};
			const next = Object.assign({}, cur);
			next[type] = !(next[type] !== false);
			// 至少保留一种题型，避免全部取消后无心可用
			if (SUPPORTED_TYPES.every((t) => next[t] === false)) {
				Log.warn("至少需要保留一种作答题型");
				return;
			}
			patchAnswer({ types: next });
			syncChips();
		});

		el.btnStart.addEventListener("click", () => {
			if (S.running) Runner.stop();
			else Runner.start();
		});
		root.getElementById("btnllm2").addEventListener("click", () => ConfigUI.open());
		// 图片弹窗关闭
		root.getElementById("imgclose").addEventListener("click", closeImage);
		el.imgmask.addEventListener("click", (e) => {
			if (e.target === el.imgmask) closeImage();
		});
		root.addEventListener("keydown", (e) => {
			if (e.key === "Escape") closeImage();
		});
		el.btnMin.addEventListener("click", () => {
			const hidden = el.body.style.display === "none";
			el.body.style.display = hidden ? "" : "none";
			el.btnMin.textContent = hidden ? "—" : "+";
		});

		restorePosition();
		bindDrag();
		syncChips();
		refreshBadges();
	}

	/** 局部更新答题配置（避免覆盖其它字段） */
	function patchAnswer(patch) {
		const cur = store.config("answer", ANSWER_DEFAULTS);
		Object.keys(patch).forEach((k) => {
			cur[k] = patch[k];
		});
		store.set("answer", cur);
	}

	/** 同步题型 chip 的选中态 */
	function syncChips() {
		if (!el.chips) return;
		const types = store.config("answer", ANSWER_DEFAULTS).types || {};
		Dom.toArray(el.chips.querySelectorAll(".chip")).forEach((chip) => {
			const t = chip.getAttribute("data-type");
			const on = types[t] !== false;
			chip.classList.toggle("on", on);
		});
	}

	function refreshBadges() {
		if (!el.tagLlm) return;
		const cfg = store.config("llm", LLM_DEFAULTS);
		const ok = !!cfg.apiKey && !!cfg.baseUrl && !!cfg.model;
		el.tagLlm.textContent = ok ? "已配置" : "未配置";
		el.tagLlm.className = "tag" + (ok ? "" : " warn");
		if (el.llmModel) el.llmModel.textContent = ok ? cfg.model : "点击右侧「配置…」填写接口信息";
	}

	/** 面板可视边界（按实际尺寸裁剪，避免宽带面板被拖出屏幕外） */
	function bounds() {
		const r = host.getBoundingClientRect();
		return {
			maxX: Math.max(0, window.innerWidth - Math.max(120, r.width)),
			maxY: Math.max(0, window.innerHeight - Math.max(40, r.height)),
		};
	}

	function restorePosition() {
		const pos = store.get("panelPos", null);
		if (pos && typeof pos.x === "number" && typeof pos.y === "number") {
			const b = bounds();
			host.style.right = "auto";
			host.style.left = clamp(pos.x, 0, b.maxX) + "px";
			host.style.top = clamp(pos.y, 0, b.maxY) + "px";
		}
	}
	function clamp(v, a, b) {
		return Math.max(a, Math.min(b, v));
	}

	function bindDrag() {
		let sx = 0,
			sy = 0,
			ox = 0,
			oy = 0,
			dragging = false;
		el.titlebar.addEventListener("pointerdown", (e) => {
			if (e.target.classList.contains("ibtn")) return;
			dragging = true;
			const r = host.getBoundingClientRect();
			sx = e.clientX;
			sy = e.clientY;
			ox = r.left;
			oy = r.top;
			host.style.right = "auto";
			try {
				el.titlebar.setPointerCapture(e.pointerId);
			} catch (err) {
				/* noop */
			}
		});
		el.titlebar.addEventListener("pointermove", (e) => {
			if (!dragging) return;
			const b = bounds();
			host.style.left = clamp(ox + e.clientX - sx, 0, b.maxX) + "px";
			host.style.top = clamp(oy + e.clientY - sy, 0, b.maxY) + "px";
		});
		const end = () => {
			if (!dragging) return;
			dragging = false;
			const r = host.getBoundingClientRect();
			store.set("panelPos", { x: Math.round(r.left), y: Math.round(r.top) });
		};
		el.titlebar.addEventListener("pointerup", end);
		el.titlebar.addEventListener("pointercancel", end);
	}

	// ============ 日志卡片流 ============
	// 每张卡片是一段独立的过程记录：系统信息 / 视频任务点 / 答题任务点 / 单道题目

	const cards = new Map(); // key → { node, body, badge, lines, kind }

	/** 建卡或取卡 */
	function ensureCard(key, opts) {
		if (!el.log) return null;
		let c = cards.get(key);
		if (c && c.node.isConnected) return c;
		const o = opts || {};
		const node = document.createElement("div");
		node.className = "card " + (o.kind || "sys");
		const hd = document.createElement("div");
		hd.className = "chd";
		const bar = document.createElement("span");
		bar.className = "bar";
		const title = document.createElement("span");
		title.className = "ctitle";
		title.textContent = o.title || "记录";
		const badge = document.createElement("span");
		badge.className = "cbadge";
		badge.textContent = o.badge || "";
		badge.style.display = o.badge ? "" : "none";
		hd.appendChild(bar);
		hd.appendChild(title);
		hd.appendChild(badge);
		const body = document.createElement("div");
		body.className = "cbody";
		node.appendChild(hd);
		node.appendChild(body);
		el.log.appendChild(node);
		c = { node, body, badge, title, lines: 0, kind: o.kind || "sys" };
		cards.set(key, c);
		trimCards();
		return c;
	}

	/** 卡片标题/徽标更新 */
	function cardMeta(key, opts) {
		const c = ensureCard(key, opts);
		if (!c) return;
		if (opts && opts.title) c.title.textContent = opts.title;
		if (opts && opts.badge !== undefined) {
			c.badge.textContent = opts.badge;
			c.badge.style.display = opts.badge ? "" : "none";
			c.badge.className = "cbadge" + (opts.badgeCls ? " " + opts.badgeCls : "");
		}
	}

	/** 追加一行到卡片 */
	function cardLine(key, level, line) {
		const c = ensureCard(key);
		if (!c) return;
		const row = document.createElement("div");
		row.className = "cline " + level;
		const ts = document.createElement("span");
		ts.className = "ts";
		ts.textContent = new Date().toTimeString().slice(0, 5);
		const tx = document.createElement("span");
		tx.className = "tx";
		tx.textContent = line;
		row.appendChild(ts);
		row.appendChild(tx);
		c.body.appendChild(row);
		c.lines++;
		cards_total++;
		autoscroll();
	}

	/** 往卡片里插入题目缩略图（点击弹出查看） */
	function cardThumb(key, dataUrl, caption, tip) {
		const c = ensureCard(key);
		if (!c || !dataUrl) return;
		const wrap = document.createElement("div");
		wrap.className = "thumb";
		const img = document.createElement("img");
		img.src = dataUrl;
		const tt = document.createElement("span");
		tt.className = "tt";
		tt.textContent = caption || "查看发送给模型的题目图";
		const small = document.createElement("small");
		small.textContent = tip || "点击弹窗查看原图";
		tt.appendChild(small);
		wrap.appendChild(img);
		wrap.appendChild(tt);
		wrap.addEventListener("click", () => openImage(dataUrl, caption));
		// 缩略图插到卡片正文最前，保证「先图后答」的阅读顺序
		if (c.body.firstChild) c.body.insertBefore(wrap, c.body.firstChild);
		else c.body.appendChild(wrap);
		autoscroll();
	}

	/** 打开图片弹窗 */
	function openImage(dataUrl, title) {
		if (!el.imgmask || !dataUrl) return;
		el.imgFull.src = dataUrl;
		el.imgTitle.textContent = title || "题目图片";
		el.imgmask.style.display = "flex";
	}
	function closeImage() {
		if (!el.imgmask) return;
		el.imgmask.style.display = "none";
		el.imgFull.removeAttribute("src");
	}

	let cards_total = 0;
	function trimCards() {
		while (cards.size > CFG.logMaxCards && el.log.firstChild) {
			const first = el.log.firstChild;
			// 按 DOM 顺序淘汰最早创建的卡片
			for (const [k, c] of cards) {
				if (c.node === first) {
					cards.delete(k);
					break;
				}
			}
			el.log.removeChild(first);
		}
		updateLogCount();
	}

	function updateLogCount() {
		if (el.logCnt) el.logCnt.textContent = cards.size > 0 ? cards.size + " 张卡片" : "";
	}

	function autoscroll() {
		if (el.log) el.log.scrollTop = el.log.scrollHeight;
		updateLogCount();
	}

	/** 清空全部卡片（重新开始时调用） */
	function clearCards() {
		cards.clear();
		if (el.log) el.log.innerHTML = "";
		cards_total = 0;
		updateLogCount();
	}

	const STATUS_CLS = {
		运行中: "p-run",
		等待中: "p-wait",
		异常: "p-err",
		已完成: "p-done",
		已停止: "p-idle",
		未启动: "p-idle",
	};

	function setProgress(barEl, done, seen) {
		if (!barEl) return;
		const pct = seen > 0 ? Math.min(100, Math.round((done / seen) * 100)) : 0;
		barEl.style.width = pct + "%";
	}

	return {
		ensure,
		refreshBadges,
		syncChips,
		// 日志卡片流 API
		ensureCard,
		cardMeta,
		cardLine,
		cardThumb,
		clearCards,
		openImage,
		closeImage,
		setStatus(s) {
			S.status = s;
			// 主按钮在「开始 / 停止」间切换
			if (el.btnStart) {
				const running = s === "运行中" || s === "等待中";
				el.btnStart.textContent = running ? "停止" : "开始刷课";
				el.btnStart.className = "mainbtn " + (running ? "stop" : "start");
			}
			if (!el.status) return;
			el.status.className = "pill " + (STATUS_CLS[s] || "p-idle");
			el.status.innerHTML = "<i></i>" + s;
		},
		setLesson(text) {
			if (el.lesson) el.lesson.textContent = text;
		},
		setTaskStat() {
			if (el.task) el.task.textContent = S.videoDone + " / " + S.videoSeen;
			setProgress(el.barV, S.videoDone, S.videoSeen);
		},
		setAnswerStat() {
			if (el.answer) el.answer.textContent = S.answerDone + " / " + S.answerSeen;
			setProgress(el.barA, S.answerDone, S.answerSeen);
		},
		setTask(text) {
			S.taskLabel = text;
			if (el.cur) el.cur.textContent = text;
		},
	};
})();
