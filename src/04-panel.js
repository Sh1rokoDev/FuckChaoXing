// ========================= 7. 悬浮控制面板（Shadow DOM 隔离，WinUI3 / Fluent 风格） =========================

const Panel = (function () {
	let host = null,
		root = null,
		el = {};

	const HTML = `
      <style>
        :host { all: initial; color-scheme: light dark; }
        * { box-sizing: border-box; margin: 0; padding: 0;
            font-family: "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI",
                         "Microsoft YaHei", "PingFang SC", sans-serif; }

        .panel {
          --font: "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI",
                  "Microsoft YaHei", "PingFang SC", sans-serif;
          --mono: "Cascadia Mono", "Consolas", "SFMono-Regular", monospace;
          --bg: rgba(243, 243, 243, .90);
          --card: rgba(255, 255, 255, .72);
          --card-solid: #ffffff;
          --stroke: rgba(0, 0, 0, .075);
          --stroke-strong: rgba(0, 0, 0, .16);
          --text: #1b1b1b;
          --text-2: #5c5c5c;
          --text-3: #8b8b8b;
          --accent: #0067c0;
          --accent-hover: #1975c5;
          --accent-pressed: #005a9e;
          --accent-text: #ffffff;
          --accent-soft: rgba(0, 103, 192, .10);
          --accent-2: #7a5af8;
          --accent-2-soft: rgba(122, 90, 248, .14);
          --success: #0f7b0f;
          --warn: #9d5d00;
          --error: #c42b1c;
          --ok-soft: rgba(15, 123, 15, .12);
          --warn-soft: rgba(157, 93, 0, .12);
          --err-soft: rgba(196, 43, 28, .12);
          --hover: rgba(0, 0, 0, .045);
          --track: rgba(0, 0, 0, .10);
          --inset: rgba(255, 255, 255, .55);
          --shadow: 0 24px 64px rgba(0, 0, 0, .24), 0 2px 8px rgba(0, 0, 0, .12);

          width: min(680px, calc(100vw - 20px));
          background: var(--bg);
          backdrop-filter: blur(40px) saturate(1.5);
          -webkit-backdrop-filter: blur(40px) saturate(1.5);
          border: 1px solid var(--stroke);
          border-radius: 8px;
          overflow: hidden;
          box-shadow: var(--shadow);
          color: var(--text);
          font-size: 12px;
          line-height: 1.4;
          position: relative;
          cursor: move;
          -webkit-font-smoothing: antialiased;
        }

        .panel.dragging, .panel.dragging * { cursor: grabbing !important;
                                             user-select: none !important; }

        /* 收起态：圆形悬浮按钮 */
        .fab { display: none; position: absolute; inset: 0; z-index: 3;
               align-items: center; justify-content: center; border: 0;
               border-radius: 50%; background: transparent; color: var(--accent-text);
               cursor: pointer; }
        .fab svg { width: 20px; height: 20px; display: block; margin-left: 2px; }
        .panel.collapsed { width: 54px; height: 54px; border-radius: 50%;
                           background: var(--accent); border-color: transparent;
                           backdrop-filter: none; -webkit-backdrop-filter: none;
                           box-shadow: 0 8px 24px rgba(0, 103, 192, .34),
                                       0 2px 6px rgba(0, 0, 0, .18);
                           cursor: pointer; }
        .panel.collapsed:hover { background: var(--accent-hover); }
        .panel.collapsed .shell { display: none; }
        .panel.collapsed .fab { display: flex; }

        /* 收起按钮（与日志标题同一水平线，带边框的方形按钮） */
        .collapse { position: absolute; top: 12px; right: 12px; z-index: 6;
                    width: 28px; height: 28px; border: 1px solid var(--stroke);
                    border-radius: 6px; display: flex; align-items: center;
                    justify-content: center; background: var(--card);
                    color: var(--text-2); cursor: pointer;
                    transition: background .12s, color .12s, border-color .12s; }
        .collapse:hover { background: var(--hover); border-color: var(--stroke-strong);
                          color: var(--text); }
        .collapse svg { width: 12px; height: 12px; display: block; }
        .shell { position: relative; transition: opacity .12s ease; }
        .panel.collapsing { background: var(--accent); border-color: transparent;
                            box-shadow: 0 8px 24px rgba(0, 103, 192, .34),
                                        0 2px 6px rgba(0, 0, 0, .18);
                            transition: background-color .18s ease, border-color .18s ease; }
        .panel.collapsing .shell { opacity: 0; }
        .panel.expanding .shell { opacity: 0; }
        .panel.expanding { transition: background-color .18s ease, border-color .18s ease; }

        /* 主体两栏 */
        .body { display: flex; align-items: stretch; height: 442px; }
        .col-left { width: 308px; flex: 0 0 auto; padding: 12px 12px 14px;
                    display: flex; flex-direction: column; gap: 10px;
                    border-right: 1px solid var(--stroke); overflow-y: auto;
                    scrollbar-width: thin; scrollbar-color: var(--stroke-strong) transparent; }
        .col-left::-webkit-scrollbar { width: 4px; }
        .col-left::-webkit-scrollbar-thumb { background: var(--stroke-strong); border-radius: 2px; }
        .col-left::-webkit-scrollbar-track { background: transparent; }
        .col-right { flex: 1 1 auto; min-width: 0; padding: 12px;
                     display: flex; flex-direction: column; }

        /* 控制台卡片（状态 + 主操作） */
        .dock { background: var(--card); border: 1px solid var(--stroke);
                border-radius: 10px; overflow: hidden;
                box-shadow: inset 0 1px 0 var(--inset), 0 1px 2px rgba(0,0,0,.03); }
        .dock[data-state="p-run"] { background: linear-gradient(180deg, var(--ok-soft), var(--card) 64%); }
        .dock[data-state="p-wait"] { background: linear-gradient(180deg, var(--warn-soft), var(--card) 64%); }
        .dock[data-state="p-err"] { background: linear-gradient(180deg, var(--err-soft), var(--card) 64%); }
        .dock[data-state="p-done"] { background: linear-gradient(180deg, var(--accent-soft), var(--card) 64%); }
        .dock-top { display: flex; align-items: center; gap: 8px; padding: 10px 12px 8px;
                    cursor: move; user-select: none; }
        .statline { display: flex; align-items: center; gap: 8px; flex: 1 1 auto; min-width: 0; }
        .pill { display: inline-flex; align-items: center; gap: 6px; height: 22px;
                padding: 0 9px; border-radius: 999px; font-size: 10.5px;
                font-weight: 600; flex: 0 0 auto; white-space: nowrap; }
        .pill i { width: 6px; height: 6px; border-radius: 50%; background: currentColor;
                  display: block; }
        .p-idle { background: var(--track); color: var(--text-2); }
        .p-run { background: var(--ok-soft); color: var(--success); }
        .p-wait { background: var(--warn-soft); color: var(--warn); }
        .p-err { background: var(--err-soft); color: var(--error); }
        .p-done { background: var(--accent-soft); color: var(--accent); }
        .p-run i { animation: pulse 1.6s ease-in-out infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: .28 } }
        .curtask { flex: 1 1 auto; min-width: 0; text-align: right; font-size: 10.5px;
                   color: var(--text-3); overflow: hidden; text-overflow: ellipsis;
                   white-space: nowrap; }

        /* 主按钮 */
        .mainbtn { width: 100%; height: 36px; border: 0; border-radius: 4px;
                   cursor: pointer; font-size: 12.5px; font-weight: 600;
                   font-family: var(--font); letter-spacing: .2px;
                   transition: background .12s, transform .06s, box-shadow .12s;
                   background: var(--accent); color: var(--accent-text);
                   box-shadow: 0 2px 6px rgba(0, 103, 192, .26); }
        .mainbtn:hover { background: var(--accent-hover); }
        .mainbtn:active { background: var(--accent-pressed); transform: translateY(1px); }
        .mainbtn.stop { background: var(--error); color: #fff;
                        box-shadow: 0 2px 6px rgba(196, 43, 28, .26); }
        .mainbtn.stop:hover { filter: brightness(1.08); }
        .mainbtn:focus-visible, .collapse:focus-visible {
          outline: 2px solid var(--accent); outline-offset: 1px; }

        /* 分区标题 */
        .sect { display: flex; align-items: center; gap: 7px; min-height: 18px; }
        .sect .st { flex: 0 0 auto; font-size: 11.5px; font-weight: 600;
                    color: var(--text); display: flex; align-items: center; }
        .sect .st::before { content: ""; width: 3px; height: 12px; border-radius: 2px;
                            background: var(--accent); margin-right: 7px; }

        /* 操作区 */
        .dock-actions { display: flex; align-items: stretch; gap: 8px;
                        padding: 0 10px 10px; }
        .dock-actions .mainbtn { flex: 1 1 auto; width: auto; }
        .iconbtn { position: relative; width: 36px; height: 36px; flex: 0 0 auto;
                   display: flex; align-items: center; justify-content: center;
                   border: 1px solid var(--stroke-strong); border-radius: 4px;
                   background: var(--card); color: var(--text-2); cursor: pointer;
                   transition: background .12s, color .12s, border-color .12s; }
        .iconbtn:hover { background: var(--hover); color: var(--text); }
        .iconbtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
        .iconbtn svg { width: 17px; height: 17px; display: block; }
        .iconbtn .dot { position: absolute; top: 6px; right: 6px; width: 6px; height: 6px;
                        border-radius: 50%; background: var(--error);
                        box-shadow: 0 0 0 2px var(--card); }
        .iconbtn .dot.ok { background: var(--success); }

        /* 开关（WinUI 设置卡片） */
        .switches { display: flex; flex-direction: column; overflow: hidden;
                    flex: 1 1 auto;
                    background: var(--card); border: 1px solid var(--stroke);
                    border-radius: 8px; box-shadow: inset 0 1px 0 var(--inset); }
        .sw { display: flex; align-items: center; gap: 9px;
              flex: 1 1 0; min-height: 38px; padding: 0 12px;
              cursor: pointer; user-select: none; color: var(--text-2);
              font-size: 11px; transition: background .12s, color .12s; }
        .sw + .sw { border-top: 1px solid var(--stroke); }
        .sw:hover { background: var(--hover); color: var(--text); }
        .sw .swlead { width: 24px; height: 24px; border-radius: 6px; flex: 0 0 auto;
                      display: flex; align-items: center; justify-content: center;
                      background: var(--track); color: var(--text-2); }
        .sw:hover .swlead { color: var(--accent); }
        .sw .swlead svg { width: 14px; height: 14px; display: block; }
        .sw .swlabel { flex: 1 1 auto; min-width: 0; }
        .sw input { position: absolute; opacity: 0; pointer-events: none; }
        .sw .track { width: 40px; height: 20px; border-radius: 10px; flex: 0 0 auto;
                     position: relative; background: transparent;
                     border: 1px solid var(--stroke-strong);
                     transition: background .15s, border-color .15s; }
        .sw .track::after { content: ""; position: absolute; top: 3px; left: 3px;
                            width: 12px; height: 12px; border-radius: 50%;
                            background: var(--text-2);
                            transition: transform .15s cubic-bezier(.2,0,0,1),
                                        background .15s; }
        .sw input:checked + .track { background: var(--accent); border-color: var(--accent); }
        .sw input:checked + .track::after { transform: translateX(20px);
                                            background: var(--accent-text); }
        .sw input:focus-visible + .track { outline: 2px solid var(--accent); outline-offset: 2px; }

        /* 日志 */
        .loghd { display: flex; align-items: center; justify-content: space-between;
                 height: 28px; margin-bottom: 8px; padding-right: 40px; flex: 0 0 auto; }
        .loghd .st { flex: 0 0 auto; font-size: 11.5px; font-weight: 600; color: var(--text);
                     display: flex; align-items: center; }
        .loghd .st::before { content: ""; width: 3px; height: 12px; border-radius: 2px;
                             background: var(--accent); margin-right: 7px; }
        .loghd .lessonprog { flex: 1 1 auto; min-width: 0; margin-left: 10px;
                             text-align: right; font-size: 10px; color: var(--text-3);
                             overflow: hidden; text-overflow: ellipsis;
                             white-space: nowrap; font-variant-numeric: tabular-nums; }
        .log { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding-right: 2px;
               display: flex; flex-direction: column; gap: 7px; cursor: auto;
               scrollbar-width: thin; scrollbar-color: var(--stroke-strong) transparent; }
        .log:empty::before { content: "暂无运行日志"; margin: auto; color: var(--text-3);
                             font-size: 11px; }
        .log::-webkit-scrollbar { width: 5px; }
        .log::-webkit-scrollbar-thumb { background: var(--stroke-strong); border-radius: 3px; }
        .log::-webkit-scrollbar-track { background: transparent; }

        /* 卡片 */
        .card { background: var(--card); border: 1px solid var(--stroke);
                border-radius: 6px; overflow: hidden; flex: 0 0 auto;
                box-shadow: 0 1px 2px rgba(0,0,0,.035); }
        .card .chd { display: flex; align-items: center; gap: 7px; padding: 6px 9px;
                     border-bottom: 1px solid var(--stroke);
                     background: linear-gradient(180deg, rgba(255,255,255,.22), transparent); }
        .card .chd .bar { width: 3px; height: 11px; border-radius: 2px; flex: 0 0 auto;
                          background: var(--text-3); }
        .card.video .chd .bar { background: var(--accent); }
        .card.job .chd .bar { background: var(--accent-2); }
        .card.q .chd .bar { background: #0f7b0f; }
        .card .chd .ctitle { flex: 1 1 auto; min-width: 0; font-size: 10.5px;
                             font-weight: 600; color: var(--text); overflow: hidden;
                             text-overflow: ellipsis; white-space: nowrap; }
        .card .chd .cbadge { flex: 0 0 auto; height: 17px; padding: 0 7px; border-radius: 999px;
                             display: inline-flex; align-items: center; font-size: 9.5px;
                             font-weight: 600; background: var(--track); color: var(--text-2); }
        .card .chd .cbadge.ok { background: var(--ok-soft); color: var(--success); }
        .card .chd .cbadge.err { background: var(--err-soft); color: var(--error); }
        .card .chd .cbadge.run { background: var(--accent-soft); color: var(--accent); }
        .card .cbody { padding: 6px 9px 8px; }
        .card .cbody:empty { display: none; }

        .cline { display: flex; gap: 7px; line-height: 1.55; font-size: 10.5px;
                 font-family: var(--mono); word-break: break-all; }
        .cline .ts { flex: 0 0 auto; padding-top: 1px; font-size: 9.5px;
                     color: var(--text-3); opacity: .72; }
        .cline .tx { flex: 1 1 auto; min-width: 0; white-space: pre-wrap;
                     color: var(--text-2); }
        .cline.INFO .tx { color: #15803d; }
        .cline.SKIP .tx { color: #2563eb; }
        .cline.WARN .tx { color: #b45309; }
        .cline.ERROR .tx { color: #dc2626; }
        .cline.OK .tx { color: #0f766e; font-weight: 600; }
        .cline.LLM .tx { color: #7c3aed; }
        .cline.PICK .tx { color: #0e7490; }

        /* 题目缩略图 */
        .thumb { display: flex; gap: 8px; align-items: center; margin-bottom: 6px;
                 padding: 6px; background: var(--accent-soft);
                 border: 1px solid transparent; border-radius: 6px; cursor: pointer;
                 transition: background .12s, border-color .12s; }
        .thumb:hover { border-color: rgba(0, 103, 192, .35); }
        .thumb img { width: 76px; height: 42px; object-fit: cover; object-position: top left;
                     border-radius: 4px; border: 1px solid var(--stroke); flex: 0 0 auto;
                     background: #fff; }
        .thumb .tt { flex: 1 1 auto; min-width: 0; color: var(--accent); font-size: 10.5px;
                     font-weight: 600; line-height: 1.4; }
        .thumb .tt small { display: block; color: var(--text-3); font-weight: 400;
                           font-size: 9.5px; margin-top: 1px; }

        /* 图片查看弹窗 */
        .imgmask { position: absolute; inset: 0; z-index: 100; padding: 18px;
                   display: flex; align-items: center; justify-content: center;
                   background: rgba(20, 20, 20, .55); cursor: default;
                   backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
        .imgmask .box { display: flex; flex-direction: column; max-width: 100%; max-height: 100%;
                        background: var(--card-solid, #fff); border-radius: 8px; overflow: hidden;
                        border: 1px solid var(--stroke);
                        box-shadow: 0 24px 60px rgba(0,0,0,.4); }
        .imgmask .bh { display: flex; align-items: center; gap: 8px; height: 38px;
                       padding: 0 8px 0 12px; border-bottom: 1px solid var(--stroke); }
        .imgmask .bh .bt { flex: 1 1 auto; font-size: 11px; font-weight: 600;
                           color: var(--text); overflow: hidden; text-overflow: ellipsis;
                           white-space: nowrap; }
        .imgmask .bh .bx { width: 30px; height: 26px; border-radius: 4px; cursor: pointer;
                           display: flex; align-items: center; justify-content: center;
                           color: var(--text-2); font-size: 16px; }
        .imgmask .bh .bx:hover { background: var(--err-soft); color: var(--error); }
        .imgmask .bb { overflow: auto; padding: 8px; background: #fff; }
        .imgmask .bb img { display: block; width: 100%; background: #fff; }

        @media (max-width: 640px) {
          .body { flex-direction: column; height: auto; max-height: 76vh; overflow-y: auto; }
          .col-left { width: auto; border-right: 0; border-bottom: 1px solid var(--stroke);
                      overflow: visible; }
          .col-right { flex: 0 0 auto; height: 244px; }
        }

        @media (prefers-color-scheme: dark) {
          .panel {
            --bg: rgba(32, 32, 32, .90);
            --card: rgba(255, 255, 255, .055);
            --card-solid: #2b2b2b;
            --stroke: rgba(255, 255, 255, .085);
            --stroke-strong: rgba(255, 255, 255, .20);
            --text: #f3f3f3;
            --text-2: #c7c7c7;
            --text-3: #9a9a9a;
            --accent: #60cdff;
            --accent-hover: #7fd8ff;
            --accent-pressed: #4cc2ff;
            --accent-text: #003a4d;
            --accent-soft: rgba(96, 205, 255, .14);
            --accent-2: #b69df8;
            --accent-2-soft: rgba(182, 157, 248, .16);
            --success: #6ccb5f;
            --warn: #f0b45a;
            --error: #ff99a4;
            --ok-soft: rgba(108, 203, 95, .16);
            --warn-soft: rgba(240, 180, 90, .16);
            --err-soft: rgba(255, 153, 164, .16);
            --hover: rgba(255, 255, 255, .06);
            --track: rgba(255, 255, 255, .12);
            --inset: rgba(255, 255, 255, .05);
            --shadow: 0 24px 64px rgba(0, 0, 0, .55), 0 2px 8px rgba(0, 0, 0, .3);
          }
          .card .chd { background: linear-gradient(180deg, rgba(255,255,255,.04), transparent); }
          .mainbtn { box-shadow: none; }
          .cline.INFO .tx { color: #6ccb5f; }
          .cline.SKIP .tx { color: #7cb8ff; }
          .cline.WARN .tx { color: #f0b45a; }
          .cline.ERROR .tx { color: #ff99a4; }
          .cline.OK .tx { color: #5fd4c4; }
          .cline.LLM .tx { color: #c3a6ff; }
          .cline.PICK .tx { color: #6fd3e0; }
        }
      </style>
      <div class="panel" id="panel">
        <button class="fab" id="fab" title="展开学习通任务助手" aria-label="展开面板">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.2 2.6 13 8l-8.8 5.4V2.6Z" fill="currentColor"/>
          </svg>
        </button>
        <div class="shell" id="shell">
          <button class="collapse" id="btnmin" title="收起面板" aria-label="收起面板">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 10.2 8 6.2l4 4" stroke="currentColor" stroke-width="1.5"
                    stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <div class="body" id="body">
            <div class="col-left">
              <div class="dock" id="dock">
                <div class="dock-top">
                  <span class="pill p-idle" id="vstatus"><i></i>未启动</span>
                  <span class="curtask" id="vcur">—</span>
                </div>
                <div class="dock-actions">
                  <button class="iconbtn" id="btnadv" title="高级设置" aria-label="高级设置">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path fill="currentColor" d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
                    </svg>
                    <span class="dot warn" id="advdot"></span>
                  </button>
                  <button class="mainbtn start" id="btnstart">开始刷课</button>
                </div>
              </div>

              <div class="sect"><span class="st">运行设置</span></div>
              <div class="switches">
                <label class="sw" title="视频静音播放（观看时长照常上报）">
                  <span class="swlead">
                    <svg viewBox="0 0 16 16" fill="none"><path d="M8.6 2.5 5.4 5.2H3.2a.7.7 0 0 0-.7.7v4.2c0 .4.3.7.7.7h2.2l3.2 2.7V2.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M11 6a2.6 2.6 0 0 1 0 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
                  </span>
                  <span class="swlabel">静音播放</span>
                  <input type="checkbox" id="optmute"><span class="track"></span>
                </label>
                <label class="sw" title="自动探测课程允许的最高倍速；若站点不允许则回退 1x">
                  <span class="swlead">
                    <svg viewBox="0 0 16 16" fill="none"><path d="M3.2 4.6 7 8l-3.8 3.4V4.6Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M8.5 4.6 12.3 8l-3.8 3.4V4.6Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
                  </span>
                  <span class="swlabel">最高倍速</span>
                  <input type="checkbox" id="optautorate"><span class="track"></span>
                </label>
                <label class="sw" title="调用多模态模型自动作答答题任务点">
                  <span class="swlead">
                    <svg viewBox="0 0 16 16" fill="none"><path d="M8 2.2l1 2.9 2.9 1-2.9 1-1 2.9-1-2.9-2.9-1 2.9-1 1-2.9Z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><path d="M12.4 9.5l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5.5-1.4Z" fill="currentColor"/></svg>
                  </span>
                  <span class="swlabel">自动答题</span>
                  <input type="checkbox" id="optanswer"><span class="track"></span>
                </label>
                <label class="sw" title="作答完成后自动点击「暂时保存」">
                  <span class="swlead">
                    <svg viewBox="0 0 16 16" fill="none"><path d="M3.5 2.8h7.2l1.8 1.8v8.6H3.5V2.8Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5.6 2.8v3.1h4.3V2.8M5.6 13.2V9.6h4.8v3.6" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
                  </span>
                  <span class="swlabel">自动暂存</span>
                  <input type="checkbox" id="opttempsave"><span class="track"></span>
                </label>
                <label class="sw" title="已有答案的题目不再作答">
                  <span class="swlead">
                    <svg viewBox="0 0 16 16" fill="none"><path d="M8 13.2A5.2 5.2 0 1 0 8 2.8a5.2 5.2 0 0 0 0 10.4Z" stroke="currentColor" stroke-width="1.2"/><path d="m5.8 8.1 1.6 1.6 2.9-3.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
                  </span>
                  <span class="swlabel">跳过已作答</span>
                  <input type="checkbox" id="optskipfilled"><span class="track"></span>
                </label>
              </div>
            </div>
            <div class="col-right">
              <div class="loghd">
                <span class="st">运行日志</span>
                <span class="lessonprog" id="vlesson" title="当前课时">—</span>
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
			panel: root.getElementById("panel"),
			shell: root.getElementById("shell"),
			fab: root.getElementById("fab"),
			dock: root.getElementById("dock"),
			status: root.getElementById("vstatus"),
			lesson: root.getElementById("vlesson"),
			cur: root.getElementById("vcur"),
			log: root.getElementById("vlog"),
			imgmask: root.getElementById("imgmask"),
			imgFull: root.getElementById("imgfull"),
			imgTitle: root.getElementById("imgtitle"),
			btnStart: root.getElementById("btnstart"),
			btnAdv: root.getElementById("btnadv"),
			advDot: root.getElementById("advdot"),
			optMute: root.getElementById("optmute"),
			optAutoRate: root.getElementById("optautorate"),
			optAnswer: root.getElementById("optanswer"),
			optTempSave: root.getElementById("opttempsave"),
			optSkipFilled: root.getElementById("optskipfilled"),
			btnMin: root.getElementById("btnmin"),
		};

		const ans = store.config("answer", ANSWER_DEFAULTS);
		const vid = store.config("video", VIDEO_DEFAULTS);
		el.optMute.checked = !!store.get("mute", false);
		el.optAutoRate.checked = vid.autoRate !== false;
		el.optAnswer.checked = !!ans.enabled;
		el.optTempSave.checked = !!ans.autoTempSave;
		el.optSkipFilled.checked = !!ans.skipFilled;

		el.optMute.addEventListener("change", () => store.set("mute", el.optMute.checked));
		el.optAutoRate.addEventListener("change", () => {
			patchVideo({ autoRate: el.optAutoRate.checked });
			Log.useSystem();
			Log.info(el.optAutoRate.checked ? "已开启自动最高倍速" : "已关闭自动倍速，按 1x 播放");
		});
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

		el.btnStart.addEventListener("click", () => {
			if (S.running) Runner.stop();
			else Runner.start();
		});
		el.btnAdv.addEventListener("click", () => ConfigUI.open());
		// 图片弹窗关闭
		root.getElementById("imgclose").addEventListener("click", closeImage);
		el.imgmask.addEventListener("click", (e) => {
			if (e.target === el.imgmask) closeImage();
		});
		root.addEventListener("keydown", (e) => {
			if (e.key === "Escape") closeImage();
		});
		el.btnMin.addEventListener("click", () => setCollapsed(true));
		el.log.addEventListener(
			"scroll",
			() => {
				followLog = isNearBottom();
			},
			{ passive: true },
		);

		restorePosition();
		bindDrag();
		bindFab();
		refreshBadges();
	}

	/** 收起 / 展开：收起后面板变为圆形播放按钮 */
	let collapseAnim = 0;

	/** 收起 / 展开：收起时面板向收起按钮方向收缩为圆形播放按钮 */
	function setCollapsed(collapsed) {
		if (!el.panel) return;
		if (el.panel.classList.contains("collapsed") === collapsed) return;
		const token = ++collapseAnim;
		const reduce =
			typeof window.matchMedia === "function" &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		const dur = 180;

		if (collapsed) {
			el.panel.classList.remove("expanding");
			const pr = el.panel.getBoundingClientRect();
			const br = el.btnMin.getBoundingClientRect();
			const size = 54;
			const targetLeft = clamp(
				br.left + br.width / 2 - size / 2,
				0,
				Math.max(0, window.innerWidth - size),
			);
			const targetTop = clamp(
				br.top + br.height / 2 - size / 2,
				0,
				Math.max(0, window.innerHeight - size),
			);
			host.style.right = "auto";
			host.style.left = pr.left + "px";
			host.style.top = pr.top + "px";
			if (reduce) {
				el.panel.classList.add("collapsed");
				el.fab.setAttribute("aria-expanded", "false");
				host.style.left = targetLeft + "px";
				host.style.top = targetTop + "px";
				return;
			}
			el.panel.classList.add("collapsing");
			el.panel.style.width = pr.width + "px";
			el.panel.style.height = pr.height + "px";
			el.panel.style.borderRadius = "8px";
			const start = { left: pr.left, top: pr.top, w: pr.width, h: pr.height };
			const t0 = performance.now();
			const step = (now) => {
				if (token !== collapseAnim) return;
				const p = Math.min(1, (now - t0) / dur);
				const e = 1 - Math.pow(1 - p, 3);
				host.style.left = start.left + (targetLeft - start.left) * e + "px";
				host.style.top = start.top + (targetTop - start.top) * e + "px";
				el.panel.style.width = start.w + (size - start.w) * e + "px";
				el.panel.style.height = start.h + (size - start.h) * e + "px";
				el.panel.style.borderRadius = 8 + (27 - 8) * e + "px";
				if (p < 1) {
					requestAnimationFrame(step);
					return;
				}
				el.panel.classList.remove("collapsing");
				el.panel.classList.add("collapsed");
				el.fab.setAttribute("aria-expanded", "false");
				el.panel.style.width = "";
				el.panel.style.height = "";
				el.panel.style.borderRadius = "";
				host.style.left = targetLeft + "px";
				host.style.top = targetTop + "px";
			};
			requestAnimationFrame(step);
			return;
		}

		// 展开：从圆形按钮位置恢复，右边缘与按钮右边缘对齐（向左下方展开）
		el.panel.classList.remove("collapsing");
		const fr = el.panel.getBoundingClientRect();
		el.panel.classList.add("expanding");
		el.panel.classList.remove("collapsed");
		el.fab.setAttribute("aria-expanded", "true");
		const full = el.panel.getBoundingClientRect();
		const targetLeft = clamp(
			fr.right - full.width,
			0,
			Math.max(0, window.innerWidth - full.width),
		);
		const targetTop = clamp(
			fr.top,
			0,
			Math.max(0, window.innerHeight - full.height),
		);
		host.style.right = "auto";
		if (reduce) {
			host.style.left = targetLeft + "px";
			host.style.top = targetTop + "px";
			el.panel.classList.remove("expanding");
			return;
		}
		host.style.left = fr.left + "px";
		host.style.top = fr.top + "px";
		el.panel.style.width = fr.width + "px";
		el.panel.style.height = fr.height + "px";
		el.panel.style.borderRadius = "27px";
		const start = { left: fr.left, top: fr.top, w: fr.width, h: fr.height };
		const t0 = performance.now();
		const step = (now) => {
			if (token !== collapseAnim) return;
			const p = Math.min(1, (now - t0) / dur);
			const e = 1 - Math.pow(1 - p, 3);
			host.style.left = start.left + (targetLeft - start.left) * e + "px";
			host.style.top = start.top + (targetTop - start.top) * e + "px";
			el.panel.style.width = start.w + (full.width - start.w) * e + "px";
			el.panel.style.height = start.h + (full.height - start.h) * e + "px";
			el.panel.style.borderRadius = 27 + (8 - 27) * e + "px";
			if (p < 1) {
				requestAnimationFrame(step);
				return;
			}
			el.panel.classList.remove("expanding");
			el.panel.style.width = "";
			el.panel.style.height = "";
			el.panel.style.borderRadius = "";
			host.style.left = targetLeft + "px";
			host.style.top = targetTop + "px";
		};
		requestAnimationFrame(step);
	}

	/** 圆形收起态支持拖动与点击展开 */
	function bindFab() {
		let down = null;
		el.fab.addEventListener("pointerdown", (e) => {
			if (!el.panel.classList.contains("collapsed")) return;
			const r = host.getBoundingClientRect();
			down = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
			host.style.right = "auto";
			try {
				el.fab.setPointerCapture(e.pointerId);
			} catch (err) {
				/* noop */
			}
		});
		el.fab.addEventListener("pointermove", (e) => {
			if (!down) return;
			const dx = e.clientX - down.sx,
				dy = e.clientY - down.sy;
			if (!down.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
			down.moved = true;
			const b = bounds();
			host.style.left = clamp(down.ox + dx, 0, b.maxX) + "px";
			host.style.top = clamp(down.oy + dy, 0, b.maxY) + "px";
		});
		const end = () => {
			if (!down) return;
			const moved = down.moved;
			down = null;
			if (moved) {
				const r = host.getBoundingClientRect();
				store.set("panelPos", { x: Math.round(r.left), y: Math.round(r.top) });
			} else {
				setCollapsed(false);
			}
		};
		el.fab.addEventListener("pointerup", end);
		el.fab.addEventListener("pointercancel", end);
	}

	/** 局部更新答题配置（避免覆盖其它字段） */
	function patchAnswer(patch) {
		const cur = store.config("answer", ANSWER_DEFAULTS);
		Object.keys(patch).forEach((k) => {
			cur[k] = patch[k];
		});
		store.set("answer", cur);
	}

	/** 局部更新视频配置 */
	function patchVideo(patch) {
		const cur = store.config("video", VIDEO_DEFAULTS);
		Object.keys(patch).forEach((k) => {
			cur[k] = patch[k];
		});
		store.set("video", cur);
	}

	function refreshBadges() {
		if (!el.advDot) return;
		const cfg = store.config("llm", LLM_DEFAULTS);
		const ok = !!(cfg.apiKey && cfg.baseUrl && cfg.model);
		el.advDot.className = "dot " + (ok ? "ok" : "warn");
		if (el.btnAdv)
			el.btnAdv.title = ok ? "高级设置 · 模型：" + cfg.model : "高级设置 · 模型未配置";
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
		let drag = null;
		el.shell.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			if (el.panel.classList.contains("collapsed")) return;
			if (el.imgmask && el.imgmask.style.display !== "none") return;
			const t = e.target;
			// 按钮 / 开关 / 缩略图 / 日志卡片 / 弹窗等区域不参与拖拽
			if (
				t.closest(
					"button, input, select, textarea, a, label, .thumb, .imgmask, .fab, .card",
				)
			)
				return;
			// 日志空白背景可拖拽，但滚动条区域留给原生滚动
			if (el.log && t.closest(".log")) {
				const lr = el.log.getBoundingClientRect();
				const sbw = el.log.offsetWidth - el.log.clientWidth;
				if (sbw > 0 && e.clientX >= lr.right - sbw) return;
			}
			const r = host.getBoundingClientRect();
			drag = {
				sx: e.clientX,
				sy: e.clientY,
				ox: r.left,
				oy: r.top,
				moved: false,
				id: e.pointerId,
			};
			host.style.right = "auto";
			try {
				el.shell.setPointerCapture(e.pointerId);
			} catch (err) {
				/* noop */
			}
			e.preventDefault();
		});
		el.shell.addEventListener("pointermove", (e) => {
			if (!drag || e.pointerId !== drag.id) return;
			const dx = e.clientX - drag.sx,
				dy = e.clientY - drag.sy;
			if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
			if (!drag.moved) {
				drag.moved = true;
				el.panel.classList.add("dragging");
			}
			e.preventDefault();
			const b = bounds();
			host.style.left = clamp(drag.ox + dx, 0, b.maxX) + "px";
			host.style.top = clamp(drag.oy + dy, 0, b.maxY) + "px";
		});
		const end = () => {
			if (!drag) return;
			const moved = drag.moved;
			drag = null;
			el.panel.classList.remove("dragging");
			if (moved) {
				const r = host.getBoundingClientRect();
				store.set("panelPos", { x: Math.round(r.left), y: Math.round(r.top) });
			}
		};
		el.shell.addEventListener("pointerup", end);
		el.shell.addEventListener("pointercancel", end);
	}

	// ============ 日志卡片流 ============
	// 每张卡片是一段独立的过程记录：系统信息 / 视频任务点 / 答题任务点 / 单道题目

	const cards = new Map(); // key → { node, body, badge, lines, kind }
	let followLog = true; // 用户停留在底部时自动跟随新日志

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
		if (opts && opts.kind) {
			c.node.className = "card " + opts.kind;
			c.kind = opts.kind;
		}
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
	}

	function isNearBottom() {
		if (!el.log) return true;
		return el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight < 80;
	}

	function autoscroll() {
		// 用户向上翻阅历史日志时不强制拉回底部
		if (el.log && (followLog || isNearBottom())) el.log.scrollTop = el.log.scrollHeight;
	}

	/** 清空全部卡片（重新开始时调用） */
	function clearCards() {
		cards.clear();
		if (el.log) el.log.innerHTML = "";
		followLog = true;
	}

	const STATUS_CLS = {
		运行中: "p-run",
		等待中: "p-wait",
		异常: "p-err",
		已完成: "p-done",
		已停止: "p-idle",
		未启动: "p-idle",
	};

	return {
		ensure,
		refreshBadges,
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
			const cls = STATUS_CLS[s] || "p-idle";
			if (el.dock) el.dock.dataset.state = cls;
			el.status.className = "pill " + cls;
			el.status.innerHTML = "<i></i>" + s;
		},
		setLesson(text) {
			if (el.lesson) el.lesson.textContent = text;
			if (el.lesson) el.lesson.title = text;
		},
		setTask(text) {
			S.taskLabel = text;
			if (el.cur) el.cur.textContent = text;
		},
	};
})();
