// ========================= 19. 启动 =========================

function main() {
	Panel.ensure();
	const ver = (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || "0.2.0";
	Log.useSystem();
	Log.info("脚本已加载（v" + ver + "）｜点击「开始刷课」启动");
	const llmCfg = store.config("llm", LLM_DEFAULTS);
	if (llmCfg.apiKey && llmCfg.model) {
		Log.info("自动答题已就绪（模型：" + llmCfg.model + "）");
	} else {
		Log.warn("自动答题未配置：点击面板「模型」行的「配置…」填写 Base URL / API Key / 多模态模型");
	}
	// 请求环境自检：无 GM 时无法绕过 CORS / 混合内容，提前明确告知，避免答题时才失败
	if (!LLM.hasGM()) {
		const pf = LLM.preflight(LLM.endpoint(llmCfg.baseUrl, llmCfg.apiStyle));
		Log.error(
			"当前未运行在油猴环境中（GM_xmlhttpRequest 不可用），模型请求将受浏览器同源策略限制。" +
				"请通过 Tampermonkey 安装并启用本脚本。",
		);
		if (!pf.ok) Log.error(pf.reason);
	}
	const lessons = scanLessons();
	const cur = lessons.find((l) => l.isCurrent);
	Panel.setLesson(
		cur ? lessons.indexOf(cur) + 1 + " / " + lessons.length + "　" + cur.title : "—",
	);
	// 记忆的运行状态：上次未停止则自动续跑（点击「停止」会清除该状态）
	if (Runner.wasRunning()) {
		Log.info("检测到刷课处于运行状态，3 秒后自动续跑（点「停止」可取消）");
		Panel.setStatus("等待中");
		Panel.setTask("准备续跑");
		setTimeout(() => {
			if (!S.running && !S.stopRequested) Runner.start();
		}, 3000);
	}
	// 调试接口：便于在浏览器控制台定位问题与二次开发（对所有页面脚本可见，仅提供只读引用）
	try {
		window.__CXAP__ = {
			Extract,
			QuestionRenderer,
			Fill,
			AnswerTask,
			AnswerProvider,
			LLM,
			FontTools,
			Dom,
			store,
			S,
			Runner,
			ConfigUI,
			Panel,
			Log,
			CFG,
			LLM_DEFAULTS,
			ANSWER_DEFAULTS,
			scanCardJobs,
			scanLessons,
		};
	} catch (e) {
		/* noop */
	}
}

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", main);
} else {
	main();
}
