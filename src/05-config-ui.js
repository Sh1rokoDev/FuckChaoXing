// ========================= 8. 配置对话框（仅模型接口 + 高级项） =========================

const ConfigUI = (function () {
	let host = null,
		root = null,
		fields = {};

	const HTML = `
    <style>
      :host { all: initial; color-scheme: light dark; }
      * { box-sizing: border-box; margin: 0; padding: 0;
          font-family: "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI",
                       "Microsoft YaHei", "PingFang SC", sans-serif; }
      .mask { position: fixed; inset: 0; display: flex; align-items: center;
              justify-content: center; z-index: 2147483600;
              background: rgba(20, 20, 20, .45);
              backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
      .dlg { --accent: #0067c0; --accent-hover: #1975c5; --accent-text: #fff;
             --stroke: rgba(0,0,0,.09); --stroke-strong: rgba(0,0,0,.16);
             --text: #1b1b1b; --text-2: #5c5c5c; --text-3: #8b8b8b;
             --field: rgba(255,255,255,.72); --card: rgba(255,255,255,.55);
             --inset: rgba(255,255,255,.60); --hover: rgba(0,0,0,.035);
             width: min(620px, calc(100vw - 32px)); max-height: 88vh; overflow: auto;
             background: rgba(243,243,243,.94);
             backdrop-filter: blur(40px) saturate(1.5);
             -webkit-backdrop-filter: blur(40px) saturate(1.5);
             border: 1px solid var(--stroke); border-radius: 8px;
             box-shadow: 0 28px 72px rgba(0,0,0,.34), 0 2px 8px rgba(0,0,0,.16);
             font-size: 12.5px; color: var(--text); }
      .hd { position: sticky; top: 0; z-index: 2; display: flex; align-items: center;
            justify-content: space-between; height: 48px; padding: 0 10px 0 18px;
            border-bottom: 1px solid var(--stroke);
            background: rgba(243,243,243,.97);
            backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }
      .hd h3 { font-family: "Segoe UI Variable Display", "Segoe UI",
               "Microsoft YaHei UI", sans-serif; font-size: 14px; font-weight: 600;
               letter-spacing: .1px; }
      .hd .x { width: 36px; height: 30px; border-radius: 4px; cursor: pointer;
               display: flex; align-items: center; justify-content: center;
               color: var(--text-2); font-size: 17px; transition: background .12s, color .12s; }
      .hd .x:hover { background: rgba(196,43,28,.12); color: #c42b1c; }
      .bd { padding: 2px 18px 14px; }
      .sec { display: flex; align-items: center; gap: 8px; margin: 18px 0 8px;
             font-size: 12px; font-weight: 600; color: var(--text); }
      .sec::before { content: ""; width: 3px; height: 12px; border-radius: 2px;
                     background: var(--accent); }
      .group { background: var(--card); border: 1px solid var(--stroke);
               border-radius: 8px; overflow: hidden;
               box-shadow: inset 0 1px 0 var(--inset); }
      .row { display: flex; align-items: center; gap: 14px;
             min-height: 50px; padding: 8px 14px; }
      .row + .row { border-top: 1px solid var(--stroke); }
      .row:hover { background: var(--hover); }
      .row .rl { flex: 0 0 128px; color: var(--text); font-size: 12.5px; }
      .row .ctl { flex: 1 1 auto; min-width: 0; }
      .row .ctl.narrow { flex: 0 1 300px; margin-left: auto; }
      .row .ctl.tiny { flex: 0 1 120px; margin-left: auto; }
      .row.col { flex-direction: column; align-items: stretch; gap: 6px; }
      .row.col .rl { flex: none; }
      .row .chips { flex: 0 1 auto; margin-left: auto; justify-content: flex-end; }
      .chkctl { margin-left: auto; width: 18px; height: 18px; flex: 0 0 auto;
                accent-color: var(--accent); cursor: pointer; }
      input[type=text], input[type=password], input[type=number], select, textarea {
        width: 100%; height: 32px; padding: 0 10px; border: 1px solid var(--stroke-strong);
        border-radius: 4px; background: var(--field); color: var(--text);
        font-family: inherit; font-size: 12px; outline: none;
        transition: border-color .12s, background .12s, box-shadow .12s; }
      textarea { height: auto; min-height: 64px; padding: 7px 10px; resize: vertical;
                 font-family: "Cascadia Mono", Consolas, monospace; }
      input:hover, select:hover, textarea:hover { border-color: rgba(0,0,0,.28); }
      input:focus, select:focus, textarea:focus { background: #fff;
        border-color: var(--accent); box-shadow: inset 0 -2px 0 var(--accent); }
      .chips { display: flex; flex-wrap: wrap; gap: 6px; }
      .chip { display: inline-flex; align-items: center; height: 28px; padding: 0 12px;
              border: 1px solid var(--stroke-strong); border-radius: 999px;
              background: transparent; color: var(--text-2); font-size: 12px;
              font-weight: 500; cursor: pointer; user-select: none;
              transition: background .12s, color .12s, border-color .12s; }
      .chip:hover { background: rgba(0,0,0,.045); color: var(--text); }
      .chip.on { background: var(--accent); border-color: var(--accent);
                 color: var(--accent-text); }
      .chip.on:hover { background: var(--accent-hover); }
      .chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
      .ft { position: sticky; bottom: 0; display: flex; align-items: center; gap: 8px;
            padding: 12px 18px 14px; border-top: 1px solid var(--stroke);
            background: rgba(243,243,243,.96); }
      .ft .grow { flex: 1; }
      button { height: 32px; padding: 0 16px; border: 1px solid transparent;
               border-radius: 4px; cursor: pointer; font-family: inherit;
               font-size: 12px; font-weight: 600;
               transition: background .12s, border-color .12s, color .12s; }
      button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
      .primary { background: var(--accent); color: var(--accent-text); }
      .primary:hover { background: var(--accent-hover); }
      .ghost { background: rgba(255,255,255,.55); color: var(--text);
               border-color: var(--stroke-strong); }
      .ghost:hover { background: rgba(255,255,255,.9); }
      .test { background: rgba(15,123,15,.10); color: #0f7b0f; }
      .test:hover { background: rgba(15,123,15,.16); }
      button:disabled { opacity: .5; cursor: not-allowed; }
      .status { max-width: 250px; overflow: hidden; text-overflow: ellipsis;
                white-space: nowrap; font-size: 11px; color: var(--text-2); }
      .status.ok { color: #0f7b0f; }
      .status.err { color: #c42b1c; }
      .status.warn { color: #9d5d00; }
      .dlg::-webkit-scrollbar { width: 10px; }
      .dlg::-webkit-scrollbar-track { background: transparent; }
      .dlg::-webkit-scrollbar-thumb { background: rgba(0,0,0,.16); border-radius: 5px;
                                      border: 3px solid transparent;
                                      background-clip: content-box; }
      .dlg::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,.28);
                                            background-clip: content-box; }
      @media (max-width: 520px) {
        .row { flex-wrap: wrap; }
        .row .rl { flex: 1 1 100%; }
        .row .ctl, .row .ctl.narrow, .row .ctl.tiny { flex: 1 1 100%; margin-left: 0; }
        .row .chips { margin-left: 0; justify-content: flex-start; }
        .chkctl { margin-left: 0; }
      }

      @media (prefers-color-scheme: dark) {
        .dlg { --accent: #60cdff; --accent-hover: #7fd8ff; --accent-text: #003a4d;
               --stroke: rgba(255,255,255,.09); --stroke-strong: rgba(255,255,255,.20);
               --text: #f3f3f3; --text-2: #c7c7c7; --text-3: #9a9a9a;
               --field: rgba(255,255,255,.06); --card: rgba(255,255,255,.055);
               --inset: rgba(255,255,255,.05); --hover: rgba(255,255,255,.055);
               background: rgba(32,32,32,.94);
               box-shadow: 0 28px 72px rgba(0,0,0,.6), 0 2px 8px rgba(0,0,0,.35); }
        .hd { background: rgba(32,32,32,.97); }
        .hd .x:hover { background: rgba(255,153,164,.16); color: #ff99a4; }
        input:focus, select:focus, textarea:focus { background: rgba(255,255,255,.10); }
        input:hover, select:hover, textarea:hover { border-color: rgba(255,255,255,.32); }
        .ghost { background: rgba(255,255,255,.06); }
        .ghost:hover { background: rgba(255,255,255,.10); }
        .test { background: rgba(108,203,95,.14); color: #6ccb5f; }
        .test:hover { background: rgba(108,203,95,.20); }
        .chip:hover { background: rgba(255,255,255,.08); }
        .ft { background: rgba(32,32,32,.96); }
        .dlg::-webkit-scrollbar-thumb { background: rgba(255,255,255,.18);
                                        background-clip: content-box; }
        .dlg::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,.30);
                                              background-clip: content-box; }
        .status.ok { color: #6ccb5f; }
        .status.err { color: #ff99a4; }
        .status.warn { color: #f0b45a; }
      }
    </style>
    <div class="mask">
      <div class="dlg">
        <div class="hd">
          <span class="ttl"><h3>高级设置</h3></span>
          <span class="x" id="close">×</span>
        </div>
        <div class="bd">
          <div class="sec">作答设置</div>
          <div class="group">
            <div class="row">
              <span class="rl">作答题型</span>
              <div class="chips" id="types">
                <span class="chip on" data-type="单选" role="button" tabindex="0">单选题</span>
                <span class="chip on" data-type="多选" role="button" tabindex="0">多选题</span>
                <span class="chip on" data-type="判断" role="button" tabindex="0">判断题</span>
              </div>
            </div>
            <div class="row">
              <label class="rl" for="unknownAction">无答案时</label>
              <select class="ctl narrow" id="unknownAction">
                <option value="skip">留空不作答（默认）</option>
                <option value="guess">随机选一个（避免空题）</option>
              </select>
            </div>
          </div>

          <div class="sec">大模型设置</div>
          <div class="group">
            <div class="row">
              <label class="rl" for="baseUrl">Base URL</label>
              <input class="ctl" type="text" id="baseUrl" placeholder="https://api.openai.com/v1">
            </div>
            <div class="row">
              <label class="rl" for="apiKey">API Key</label>
              <input class="ctl" type="password" id="apiKey" placeholder="sk-...">
            </div>
            <div class="row">
              <label class="rl" for="model">模型</label>
              <input class="ctl" type="text" id="model" placeholder="gpt-4o / qwen-vl-max / glm-4v ...">
            </div>
            <div class="row">
              <label class="rl" for="apiStyle">接口风格</label>
              <select class="ctl narrow" id="apiStyle">
                <option value="chat">Chat Completions（/chat/completions）</option>
                <option value="responses">Responses API（/responses）</option>
              </select>
            </div>
            <div class="row">
              <label class="rl" for="temperature">Temperature</label>
              <input class="ctl tiny" type="number" id="temperature" step="0.1" min="0" max="2">
            </div>
            <div class="row">
              <label class="rl" for="maxTokens">Max tokens</label>
              <input class="ctl tiny" type="number" id="maxTokens" step="128" min="64">
            </div>
            <div class="row col">
              <label class="rl" for="extraHeaders">额外请求头</label>
              <textarea class="ctl" id="extraHeaders" placeholder='{"X-Foo":"bar"}'></textarea>
            </div>
          </div>

          <div class="sec">调试</div>
          <div class="group">
            <label class="row">
              <span class="rl">输出请求与响应原文</span>
              <input class="chkctl" type="checkbox" id="debugDump">
            </label>
          </div>
        </div>
        <div class="ft">
          <button class="test" id="test">测试连通性</button>
          <span class="status" id="status"></span>
          <span class="grow"></span>
          <button class="ghost" id="cancel">取消</button>
          <button class="primary" id="save">保存</button>
        </div>
      </div>
    </div>`;

	function ensure() {
		if (host && host.isConnected) return;
		host = document.createElement("div");
		host.id = "cxap-config-host";
		host.style.cssText = "position:fixed;inset:0;z-index:2147483600;";
		root = host.attachShadow({ mode: "open" });
		root.innerHTML = HTML;
		document.body.appendChild(host);
		S.panels.push(host);

		fields = {
			baseUrl: root.getElementById("baseUrl"),
			apiKey: root.getElementById("apiKey"),
			model: root.getElementById("model"),
			apiStyle: root.getElementById("apiStyle"),
			temperature: root.getElementById("temperature"),
			maxTokens: root.getElementById("maxTokens"),
			extraHeaders: root.getElementById("extraHeaders"),
			unknownAction: root.getElementById("unknownAction"),
			debugDump: root.getElementById("debugDump"),
			types: root.getElementById("types"),
			status: root.getElementById("status"),
		};

		root.getElementById("close").addEventListener("click", close);
		root.getElementById("cancel").addEventListener("click", close);
		root.getElementById("save").addEventListener("click", save);
		root.getElementById("test").addEventListener("click", testConnection);

		Array.from(fields.types.querySelectorAll(".chip")).forEach((chip) => {
			const toggle = () => {
				if (chip.classList.contains("on")) {
					// 至少保留一种题型
					const on = fields.types.querySelectorAll(".chip.on");
					if (on.length <= 1) return;
					chip.classList.remove("on");
				} else {
					chip.classList.add("on");
				}
			};
			chip.addEventListener("click", toggle);
			chip.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					toggle();
				}
			});
		});
	}

	function syncChips(types) {
		const map = types && typeof types === "object" ? types : ANSWER_DEFAULTS.types;
		Array.from(fields.types.querySelectorAll(".chip")).forEach((chip) => {
			chip.classList.toggle("on", map[chip.dataset.type] !== false);
		});
	}

	function readTypes() {
		const types = {};
		Array.from(fields.types.querySelectorAll(".chip")).forEach((chip) => {
			types[chip.dataset.type] = chip.classList.contains("on");
		});
		return types;
	}

	function fill(cfg, ans) {
		fields.baseUrl.value = cfg.baseUrl || "";
		fields.apiKey.value = cfg.apiKey || "";
		fields.model.value = cfg.model || "";
		fields.apiStyle.value = cfg.apiStyle || "chat";
		fields.temperature.value = String(cfg.temperature);
		fields.maxTokens.value = String(cfg.maxTokens);
		fields.extraHeaders.value = cfg.extraHeaders || "";
		fields.unknownAction.value = ans.unknownAction || "skip";
		fields.debugDump.checked = !!ans.debugDump;
		syncChips(ans.types);
		setStatus("", "");
	}

	function setStatus(text, cls) {
		if (!fields.status) return;
		fields.status.textContent = text;
		fields.status.title = text;
		fields.status.className = "status " + (cls || "");
	}

	function read() {
		const cfg = {
			baseUrl: fields.baseUrl.value.trim().replace(/\/+$/, ""),
			apiKey: fields.apiKey.value.trim(),
			model: fields.model.value.trim(),
			apiStyle: fields.apiStyle.value,
			temperature: parseFloat(fields.temperature.value) || 0,
			maxTokens: parseInt(fields.maxTokens.value, 10) || 2048,
			jsonMode: true,
			extraHeaders: fields.extraHeaders.value.trim(),
		};
		const ans = {
			unknownAction: fields.unknownAction.value,
			debugDump: fields.debugDump.checked,
			types: readTypes(),
		};
		return { cfg, ans };
	}

	function validate(cfg) {
		if (!cfg.baseUrl) return "请填写 Base URL";
		if (!/^https?:\/\//i.test(cfg.baseUrl)) return "Base URL 必须以 http(s):// 开头";
		if (!cfg.apiKey) return "请填写 API Key";
		if (!cfg.model) return "请填写模型名";
		return null;
	}

	function save() {
		const { cfg, ans } = read();
		const err = validate(cfg);
		if (err) {
			setStatus(err, "err");
			return false;
		}
		store.set("llm", cfg);
		// 只覆盖本弹窗负责的字段，其余（自动暂存 / 跳过已作答等）保留面板上的设置
		const merged = store.config("answer", ANSWER_DEFAULTS);
		merged.unknownAction = ans.unknownAction;
		merged.debugDump = ans.debugDump;
		merged.types = ans.types;
		store.set("answer", merged);
		Panel.refreshBadges();
		setStatus("已保存", "ok");
		setTimeout(close, 420);
		return true;
	}

	async function testConnection() {
		const { cfg } = read();
		const err = validate(cfg);
		if (err) return setStatus(err, "err");
		const btn = root.getElementById("test");
		btn.disabled = true;
		setStatus("请求中…", "");
		try {
			const res = await LLM.chat({
				config: cfg,
				messages: [
					{ role: "user", content: [{ type: "text", text: "ping，只回复 pong" }] },
				],
				timeout: 60000,
				// 连通性测试不需要 JSON 输出（提示词不含 "json" 会被接口拒绝），
				// 同时给足输出预算：推理模型的思考 token 也算在里面
				jsonMode: false,
				maxTokens: 512,
			});
			const txt = String(res.text || "").trim();
			if (txt) {
				setStatus("连通成功：" + txt.slice(0, 40), "ok");
				return;
			}
			// HTTP 通了但没有可见文字：多为输出预算被推理过程占用（status=incomplete）
			const raw = res.raw || {};
			const incomplete =
				raw.status === "incomplete" &&
				raw.incomplete_details &&
				raw.incomplete_details.reason === "length";
			setStatus(
				incomplete
					? "连通成功，但输出被截断（思考占用了 max tokens，可调大「max tokens」）"
					: "连通成功，但模型未返回文字",
				"warn",
			);
		} catch (e) {
			setStatus("失败：" + ((e && e.message) || e), "err");
		} finally {
			btn.disabled = false;
		}
	}

	function open() {
		ensure();
		fill(store.config("llm", LLM_DEFAULTS), store.config("answer", ANSWER_DEFAULTS));
		const dlg = root.querySelector(".dlg");
		if (dlg) dlg.scrollTop = 0;
		host.style.display = "";
	}

	function close() {
		if (host) host.style.display = "none";
	}

	return { open, close, save };
})();
