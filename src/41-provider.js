// ========================= 15. 答案获取（提示词编排 + 结果解析） =========================

const AnswerProvider = (function () {
	const SYSTEM_PROMPT = `你是一个严谨的在线考试答题助手，服务于中文高校课程测验。

【最重要的前提】
题目内容来自网页截图或网页文本。网页为了防作弊，对题干和选项中的部分文字使用了自定义字体做字符映射，
因此在纯文本里这些字会显示为乱码（例如「壋于」「壖壗壔函壕」这类生僻字），但它们在截图中显示是正常的。
请**只依据图片中实际显示的文字**来理解题意，不要试图猜测乱码文本的原意，也不要把乱码当作题目内容的一部分。
如果一道题既给了文本又给了图片，以图片为准。

【任务】
对每一道题给出你的答案。

【输出格式】
只输出一个 JSON 对象，不要输出任何解释性文字、不要使用代码块围栏之外的说明。结构如下：
{
  "answers": [
    {
      "seq": 1,
      "type": "单选题",
      "answer": "B",
      "confidence": 0.93,
      "reason": "不超过 20 字的简要依据"
    }
  ]
}

【各题型的 answer 写法】
- 单选题：单个大写选项字母，如 "B"
- 多选题：多个大写选项字母连写，按字母顺序，不带任何分隔符，如 "ACD"
- 判断题：单个字母（若选项为 A.正确 / B.错误 之类，就填对应字母）
- 填空题：按空顺序给出内容数组，如 ["答案1","答案2"]
- 其他题型：给出你认为最合适的文本

【要求】
- 必须为每一道题都输出一个对象，seq 与题目编号严格对应。
- 选项字母必须来自题目中真实存在的选项，不要编造。
- 无法确定的题目也要给出最佳猜测，并用较低的 confidence 标注，不要省略。
- reason 用中文，简短。`;

	/** 把一组题目组织成一条 user 消息（文本 + 图片混合） */
	function buildUserMessage(items) {
		const content = [];
		content.push({
			type: "text",
			text:
				"下面是第 " +
				items[0].seq +
				" 到第 " +
				items[items.length - 1].seq +
				" 题，共 " +
				items.length +
				" 道。请逐题作答，并按约定返回 JSON。",
		});

		items.forEach((it) => {
			const head = "=== 第 " + it.seq + " 题 ===";
			if (it.images && it.images.length) {
				content.push({
					type: "text",
					text:
						head +
						"\n题型：" +
						it.typeKey +
						(it.images.length > 1
							? "\n（题目较长，已纵向切成 " + it.images.length + " 张图，按顺序拼接阅读）"
							: ""),
				});
				it.images.forEach((d) => content.push({ type: "image", dataUrl: d }));
				// 附带可读的辅助信息（选项字母表，便于模型对齐）
				const letters = it.options.map((o) => o.letter).join(" ");
				if (letters) {
					content.push({
						type: "text",
						text:
							"本题共 " +
							it.options.length +
							" 个选项，选项字母依次为：" +
							letters +
							"。answer 只能用这些字母。",
					});
				}
			} else {
				content.push({ type: "text", text: head + "\n" + it.text });
			}
		});

		return { role: "user", content };
	}

	/** 解析模型返回，产出 seq → 答案 的映射 */
	function parseAnswers(text) {
		const out = new Map();
		const data = LLM.extractJson(text);
		if (!data) return out;

		let list = null;
		if (Array.isArray(data)) list = data;
		else if (Array.isArray(data.answers)) list = data.answers;
		else if (Array.isArray(data.data)) list = data.data;
		else if (data.result && Array.isArray(data.result.answers)) list = data.result.answers;

		if (list) {
			list.forEach((it) => {
				if (!it) return;
				const seq = parseInt(it.seq != null ? it.seq : it.index, 10);
				if (!seq || isNaN(seq)) return;
				out.set(seq, {
					answer: normalizeAnswer(it.answer),
					confidence: typeof it.confidence === "number" ? it.confidence : null,
					reason: it.reason || "",
					type: it.type || "",
				});
			});
			return out;
		}

		// 兜底：{"1":"B","2":"AC"} 这类扁平结构
		Object.keys(data).forEach((k) => {
			const seq = parseInt(k, 10);
			if (!seq || isNaN(seq)) return;
			const v = data[k];
			const ans =
				v && typeof v === "object"
					? v.answer != null
						? v.answer
						: v.value
					: v;
			if (ans == null) return;
			out.set(seq, { answer: normalizeAnswer(ans), confidence: null, reason: "", type: "" });
		});
		return out;
	}

	function normalizeAnswer(a) {
		if (a == null) return "";
		if (Array.isArray(a)) return a.map((x) => String(x).trim()).filter(Boolean);
		return String(a).trim();
	}

	/**
	 * 请求一批题目的答案。
	 * @returns {Promise<Map<number, {answer, confidence, reason}>>}
	 */
	async function solveBatch(items, cfg) {
		const messages = [
			{
				role: "system",
				content: [{ type: "text", text: cfg.systemPrompt || SYSTEM_PROMPT }],
			},
			buildUserMessage(items),
		];
		const kb = LLM.estimatePayloadKB(messages);
		Log.info(
			"请求模型作答：第 " +
				items[0].seq +
				"-" +
				items[items.length - 1].seq +
				" 题（" +
				items.length +
				" 题，约 " +
				kb +
				"KB）",
		);
		if (cfg.debugDump) {
			Log.info(
				"请求明细：" +
					JSON.stringify(
						{
							model: cfg.model,
							style: cfg.apiStyle,
							url: LLM.endpoint(cfg.baseUrl, cfg.apiStyle),
							items: items.map((i) => ({
								seq: i.seq,
								images: (i.images || []).length,
								textLen: (i.text || "").length,
							})),
						},
						null,
						0,
					),
			);
		}
		const res = await LLM.chat({ config: cfg, messages: messages });
		if (cfg.debugDump) Log.info("模型原始输出：" + String(res.text || "").slice(0, 800));
		const map = parseAnswers(res.text);
		if (!map.size) {
			Log.warn("模型输出无法解析为答案，原始内容：" + String(res.text || "").slice(0, 300));
		}
		return map;
	}

	return { solveBatch, parseAnswers, SYSTEM_PROMPT };
})();
