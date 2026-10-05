// ========================= 8. 配置对话框（仅模型接口 + 高级项） =========================

const ConfigUI = (function () {
	let host = null,
		root = null,
		fields = {};

	const HTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; margin: 0; padding: 0;
          font-family: "Microsoft YaHei", "PingFang SC", -apple-system, sans-serif; }
      .mask { position: fixed; inset: 0; background: rgba(15,23,42,.45); display: flex;
              align-items: center; justify-content: center; z-index: 2147483600;
              backdrop-filter: blur(2px); }
      .dlg { width: 580px; max-height: 88vh; overflow: auto; background: #fff;
             border-radius: 16px; box-shadow: 0 24px 64px rgba(15,23,42,.28);
             font-size: 13px; color: #0f172a; }
      .hd { padding: 18px 22px 14px; display: flex; justify-content: space-between;
            align-items: center; border-bottom: 1px solid #eef2f7; position: sticky; top: 0;
            background: #fff; border-radius: 16px 16px 0 0; z-index: 2; }
      .hd .ttl { display: flex; align-items: center; gap: 9px; }
      .hd .dot { width: 9px; height: 9px; border-radius: 50%; background: #4f46e5; }
      .hd h3 { font-size: 15px; font-weight: 650; letter-spacing: .2px; }
      .hd .x { cursor: pointer; width: 26px; height: 26px; border-radius: 7px; display: flex;
               align-items: center; justify-content: center; color: #94a3b8; font-size: 17px;
               transition: all .15s; }
      .hd .x:hover { background: #fef2f2; color: #ef4444; }
      .bd { padding: 6px 22px 4px; }
      .sec { margin: 16px 0 10px; font-weight: 650; color: #334155; font-size: 12.5px;
             display: flex; align-items: center; gap: 7px; }
      .sec::before { content: ""; width: 3px; height: 13px; border-radius: 2px; background: #4f46e5; }
      .sec .opt { color: #94a3b8; font-weight: 400; font-size: 11px; }
      .grid { display: grid; grid-template-columns: 112px 1fr; gap: 10px 14px; align-items: center; }
      .grid label { color: #64748b; font-size: 12.5px; }
      .grid .hint { grid-column: 2; color: #94a3b8; font-size: 11px; margin-top: -5px;
                    line-height: 1.5; }
      input[type=text], input[type=password], input[type=number], select, textarea {
        width: 100%; padding: 8px 11px; border: 1px solid #e2e8f0; border-radius: 9px;
        font-size: 12.5px; color: #0f172a; background: #f8fafc; outline: none;
        transition: all .15s; }
      input:hover, select:hover, textarea:hover { border-color: #cbd5e1; }
      input:focus, select:focus, textarea:focus { border-color: #818cf8; background: #fff;
        box-shadow: 0 0 0 3px rgba(99,102,241,.12); }
      textarea { min-height: 60px; resize: vertical; font-family: Consolas, monospace; }
      .chk { display: flex; align-items: center; gap: 8px; color: #475569; font-size: 12.5px;
             cursor: pointer; user-select: none; }
      .chk input { width: 15px; height: 15px; accent-color: #4f46e5; cursor: pointer; }
      .ft { display: flex; gap: 10px; padding: 16px 22px 20px; align-items: center;
            position: sticky; bottom: 0; background: #fff; border-top: 1px solid #eef2f7;
            border-radius: 0 0 16px 16px; }
      .ft .grow { flex: 1; }
      button { padding: 9px 18px; border: 0; border-radius: 9px; cursor: pointer;
               font-size: 12.5px; font-weight: 600; transition: all .15s; }
      .primary { background: #4f46e5; color: #fff; }
      .primary:hover { background: #4338ca; }
      .ghost { background: #f1f5f9; color: #475569; }
      .ghost:hover { background: #e2e8f0; }
      .test { background: #ecfdf5; color: #047857; }
      .test:hover { background: #d1fae5; }
      button:disabled { opacity: .5; cursor: not-allowed; }
      .status { font-size: 12px; color: #64748b; max-width: 250px; overflow: hidden;
                text-overflow: ellipsis; white-space: nowrap; }
      .status.ok { color: #047857; }
      .status.err { color: #dc2626; }
    </style>
    <div class="mask">
      <div class="dlg">
        <div class="hd">
          <span class="ttl"><span class="dot"></span><h3>模型配置</h3></span>
          <span class="x" id="close">×</span>
        </div>
        <div class="bd">
          <div class="sec">接口（OpenAI 兼容）</div>
          <div class="grid">
            <label>Base URL</label>
            <input type="text" id="baseUrl" placeholder="https://api.openai.com/v1">
            <div class="hint">通常以 /v1 结尾；脚本会自动补全 /chat/completions 或 /responses</div>

            <label>API Key</label>
            <input type="password" id="apiKey" placeholder="sk-...">
            <div class="hint">仅保存在本地浏览器存储中，不会上传到任何第三方</div>

            <label>模型</label>
            <input type="text" id="model" placeholder="gpt-4o / qwen-vl-max / glm-4v ...">
            <div class="hint">必须是支持图片输入的多模态模型（题目以位图发送）</div>

            <label>接口风格</label>
            <select id="apiStyle">
              <option value="chat">Chat Completions（/chat/completions）</option>
              <option value="responses">Responses API（/responses）</option>
            </select>

            <label>temperature</label>
            <input type="number" id="temperature" step="0.1" min="0" max="2">

            <label>max tokens</label>
            <input type="number" id="maxTokens" step="128" min="64">

            <label>额外请求头</label>
            <textarea id="extraHeaders" placeholder='{"X-Foo":"bar"}'></textarea>
          </div>

          <div class="sec">高级 <span class="opt">（日常使用保持默认即可）</span></div>
          <div class="grid">
            <label>无答案时</label>
            <select id="unknownAction">
              <option value="skip">留空不作答（默认）</option>
              <option value="guess">随机选一个（避免空题）</option>
            </select>

            <label>批量大小</label>
            <input type="number" id="llmBatchSize" min="1" max="20">
            <div class="hint">每次请求提交的题目数量；默认 1（逐题作答，日志最清晰）</div>

            <label>其他</label>
            <div class="chk"><input type="checkbox" id="debugDump"> 日志输出请求与响应原文（排错用）</div>
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
			llmBatchSize: root.getElementById("llmBatchSize"),
			debugDump: root.getElementById("debugDump"),
			status: root.getElementById("status"),
		};

		root.getElementById("close").addEventListener("click", close);
		root.getElementById("cancel").addEventListener("click", close);
		root.getElementById("save").addEventListener("click", save);
		root.getElementById("test").addEventListener("click", testConnection);
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
		fields.llmBatchSize.value = String(cfg.batchSize || CFG.llmBatchSize);
		fields.debugDump.checked = !!ans.debugDump;
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
			batchSize: parseInt(fields.llmBatchSize.value, 10) || CFG.llmBatchSize,
		};
		const ans = {
			unknownAction: fields.unknownAction.value,
			debugDump: fields.debugDump.checked,
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
		// 只覆盖本弹窗负责的字段，其余（自动暂存 / 题型勾选等）保留面板上的设置
		const merged = store.config("answer", ANSWER_DEFAULTS);
		merged.unknownAction = ans.unknownAction;
		merged.debugDump = ans.debugDump;
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
				timeout: 45000,
				maxTokens: 16,
			});
			const txt = String(res.text || "").slice(0, 40);
			setStatus("连通成功：" + (txt || "(空响应)"), "ok");
		} catch (e) {
			setStatus("失败：" + ((e && e.message) || e), "err");
		} finally {
			btn.disabled = false;
		}
	}

	function open() {
		ensure();
		fill(store.config("llm", LLM_DEFAULTS), store.config("answer", ANSWER_DEFAULTS));
		host.style.display = "";
	}

	function close() {
		if (host) host.style.display = "none";
	}

	return { open, close, save };
})();
