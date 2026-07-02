// ==UserScript==
// @name         XJTU课程录像分集与批量下载
// @namespace    https://github.com/ShikiForever
// @version      1.0
// @description  优化下载体验，主推TXT导出，尝试修复跨域0KB问题 (适配 lms.xjtu.edu.cn)
// @author       ShikiForever
// @match        *://lms.xjtu.edu.cn/*
// @connect      lms.xjtu.edu.cn
// @connect      rms-v5.xjtu.edu.cn
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @license      MIT
// @run-at       document-end
// @downloadURL https://update.greasyfork.org/scripts/585319/XJTU%E8%AF%BE%E7%A8%8B%E5%BD%95%E5%83%8F%E5%88%86%E9%9B%86%E4%B8%8E%E6%89%B9%E9%87%8F%E4%B8%8B%E8%BD%BD.user.js
// @updateURL https://update.greasyfork.org/scripts/585319/XJTU%E8%AF%BE%E7%A8%8B%E5%BD%95%E5%83%8F%E5%88%86%E9%9B%86%E4%B8%8E%E6%89%B9%E9%87%8F%E4%B8%8B%E8%BD%BD.meta.js
// ==/UserScript==

(function() {
    'use strict';

    const CACHE_PREFIX = "xjtu_course_cache_v6_";
    const MODE_KEY = "xjtu_player_mode";

    // --- 核心逻辑 ---
    const Core = {
        getCourseId: function() {
            const extract = (url) => {
                const p = url.match(/\/course\/(\d+)/);
                if (p) return p[1];
                const q = url.match(/[?&]course_id=(\d+)/);
                if (q) return q[1];
                return null;
            };
            let id = extract(window.location.href);
            if (!id) { try { id = extract(window.top.location.href); } catch(e) {} }
            return id;
        },

        getCurrentActivityId: function() {
            const extract = (url) => {
                const p = url.match(/learning-activity#\/(\d+)/);
                if (p) return parseInt(p[1]);
                const q = url.match(/[?&]activity_id=(\d+)/);
                if (q) return parseInt(q[1]);
                return null;
            };
            let id = extract(window.location.href);
            if (!id) { try { id = extract(window.top.location.href); } catch(e) {} }
            return id;
        },

        request: function(url) {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: "GET", url: url,
                    headers: { 'Content-Type': 'application/json' },
                    anonymous: false,
                    onload: function(response) {
                        if (response.status >= 200 && response.status < 300) {
                            try { resolve(JSON.parse(response.responseText)); }
                            catch (e) { reject("解析JSON失败"); }
                        } else { reject("HTTP错误: " + response.status); }
                    },
                    onerror: function(err) { reject("网络请求错误"); }
                });
            });
        },

        getData: function(callback) {
            const courseId = this.getCourseId();
            if (!courseId) return;

            const cacheKey = CACHE_PREFIX + courseId;
            const cachedJson = sessionStorage.getItem(cacheKey);
            if (cachedJson) {
                callback(JSON.parse(cachedJson));
                return;
            }

            const apiUrl = `https://lms.xjtu.edu.cn/api/courses/${courseId}/activities?sub_course_id=0`;

            this.request(apiUrl).then(data => {
                if (data && data.activities) {
                    let list = data.activities.map(item => ({
                        id: item.id,
                        title: item.title,
                        type: item.type,
                        time: new Date(item.start_time || item.created_at || 0).getTime()
                    }));
                    list.sort((a, b) => a.time - b.time);
                    sessionStorage.setItem(cacheKey, JSON.stringify(list));
                    callback(list);
                }
            }).catch(err => console.error(`请求失败`, err));
        },

        getFilteredList: function(list) {
            const mode = localStorage.getItem(MODE_KEY) || 'new';
            return list.filter(item => {
                const isNewVersion = /\d{2}:\d{2}:\d{2}/.test(item.title) || item.type === 'lesson';
                return mode === 'new' ? isNewVersion : !isNewVersion;
            });
        },

        jump: function(activityId) {
            const courseId = this.getCourseId();
            const url = `https://lms.xjtu.edu.cn/course/${courseId}/learning-activity#/${activityId}`;
            try { window.top.location.href = url; }
            catch (e) { window.open(url, '_top'); }
        }
    };

    // --- 下载核心逻辑 ---
    const Downloader = {
        collectUrls: async function(selectedItems, types, statusCallback) {
            let tasks = [];

            for (let i = 0; i < selectedItems.length; i++) {
                let item = selectedItems[i];
                statusCallback(`正在获取第 ${i+1}/${selectedItems.length} 集链接...`);

                let detailUrl = `https://lms.xjtu.edu.cn/api/activities/${item.id}?sub_course_id=0`;

                try {
                    let data = await Core.request(detailUrl);
                    let foundVideos = [];
                    let visited = new Set();

                    function deepSearch(node) {
                        if (!node || typeof node !== 'object') return;
                        if (visited.has(node)) return;
                        visited.add(node);

                        if (node.camera_type && typeof node.camera_type === 'string') {
                            let url = node.file_url || node.url || node.play_url;
                            if (url) foundVideos.push({ camera_type: node.camera_type, url: url });
                        }
                        else if (node.url && typeof node.url === 'string' && (node.url.includes('.mp4') || node.url.includes('.m3u8'))) {
                            foundVideos.push({ camera_type: 'OLD_VERSION', url: node.url });
                        }

                        for (let key in node) { deepSearch(node[key]); }
                    }

                    deepSearch(data);

                    let hasMatch = false;
                    foundVideos.forEach(v => {
                        if (types.includes(v.camera_type) || v.camera_type === 'OLD_VERSION') {
                            let suffix = "";
                            if (v.camera_type === 'INSTRUCTOR') suffix = "_老师机位";
                            else if (v.camera_type === 'ENCODER') suffix = "_电脑屏幕";

                            let safeTitle = item.title.replace(/[\\/:*?"<>|]/g, "_");
                            tasks.push({
                                filename: `${safeTitle}${suffix}.mp4`,
                                url: v.url
                            });
                            hasMatch = true;
                        }
                    });

                    if (!hasMatch) console.warn(`[XJTU-Helper] 第 ${i+1} 集 (${item.title}) 找不到下载地址，可能服务器未返回或使用了其他加密接口。`);
                } catch (e) {
                    console.error("获取链接失败", item.id, e);
                }
                await new Promise(r => setTimeout(r, 400));
            }
            return tasks;
        },

        exportTxt: function(tasks) {
            if (tasks.length === 0) return alert("未找到符合条件的下载链接！");
            let content = tasks.map(t => t.url).join('\n');
            let blob = new Blob([content], { type: "text/plain;charset=utf-8" });
            let link = document.createElement("a");
            link.href = URL.createObjectURL(blob);
            link.download = `XJTU_Course_Links_${new Date().getTime()}.txt`;
            link.click();
        },

        browserDownload: function(tasks, statusCallback) {
            if (tasks.length === 0) return alert("未找到符合条件的下载链接！");
            statusCallback(`正在推送下载任务，若生成 0KB 文件请改用 TXT 导出。`);

            tasks.forEach((task, idx) => {
                setTimeout(() => {
                    GM_download({
                        url: task.url,
                        name: task.filename,
                        saveAs: false,
                        headers: { // 尝试添加请求头绕过防盗链，但不保证一定能解决 0KB
                            "Referer": "https://lms.xjtu.edu.cn/",
                            "Origin": "https://lms.xjtu.edu.cn/"
                        }
                    });
                }, idx * 1000);
            });
            setTimeout(() => { statusCallback("下载任务已推送到浏览器！"); }, tasks.length * 1000);
        }
    };

    // --- UI 注入工具 ---
    const getTargetBtnDeep = () => {
        function search(root) {
            if (!root) return null;
            const target = Array.from(root.querySelectorAll('span')).find(el => el.textContent.trim() === '倍速');
            if (target) return target;
            for (let node of root.querySelectorAll('*')) {
                if (node.shadowRoot) {
                    const found = search(node.shadowRoot);
                    if (found) return found;
                }
            }
            return null;
        }
        return search(document);
    };

    const UI = {
        createBaseModal: function(title, width) {
            const oldList = document.getElementById('xjtu-helper-list');
            const oldDown = document.getElementById('xjtu-helper-dl-modal');
            if (oldList) oldList.remove();
            if (oldDown) oldDown.remove();

            const modal = document.createElement('div');
            modal.style = `
                position: fixed; top: 10%; right: 20px; bottom: 10%; width: ${width}px;
                background: rgba(20, 20, 20, 0.95); z-index: 2147483647; color: #fff;
                display: flex; flex-direction: column; border-radius: 8px;
                box-shadow: 0 4px 16px rgba(0,0,0,0.8); font-size: 14px; font-family: sans-serif;
            `;

            const header = document.createElement('div');
            header.style = "border-bottom: 1px solid #555; padding: 15px; display: flex; justify-content: space-between; align-items: center;";

            const titleWrap = document.createElement('strong');
            titleWrap.innerText = title;

            const rightWrap = document.createElement('div');
            rightWrap.style = "display: flex; align-items: center; gap: 12px;";

            const closeBtn = document.createElement('span');
            closeBtn.innerHTML = '✖';
            closeBtn.style = "cursor:pointer; font-size:16px; user-select:none; color: #999; transition: color 0.2s;";
            closeBtn.onmouseover = () => closeBtn.style.color = '#fff';
            closeBtn.onmouseout = () => closeBtn.style.color = '#999';
            closeBtn.onclick = () => modal.remove();

            rightWrap.appendChild(closeBtn);
            header.appendChild(titleWrap);
            header.appendChild(rightWrap);
            modal.appendChild(header);

            return { modal, titleWrap, rightWrap, closeBtn };
        },

        showList: function(fullList) {
            const { modal, titleWrap, rightWrap } = UI.createBaseModal("分集列表", 340);
            modal.id = 'xjtu-helper-list';

            let currentMode = localStorage.getItem(MODE_KEY) || 'new';
            const currentId = Core.getCurrentActivityId();

            const toggleBtn = document.createElement('span');
            toggleBtn.style = "cursor:pointer; font-size:12px; background:#4caf50; padding:4px 8px; border-radius:4px; user-select:none; font-weight:bold;";
            rightWrap.insertBefore(toggleBtn, rightWrap.firstChild);

            const listContainer = document.createElement('div');
            listContainer.style = "flex: 1; overflow-y: auto; padding: 5px 15px 15px 15px; scrollbar-width: thin; scrollbar-color: #666 #222;";
            modal.appendChild(listContainer);
            document.body.appendChild(modal);

            const render = () => {
                listContainer.innerHTML = '';
                const filteredList = Core.getFilteredList(fullList);

                titleWrap.innerText = `分集列表 (${filteredList.length})`;
                toggleBtn.innerText = currentMode === 'new' ? '🎥 切至旧版' : '📺 切至新版';
                toggleBtn.style.background = currentMode === 'new' ? '#4caf50' : '#e67e22';

                if(filteredList.length === 0) {
                    listContainer.innerHTML = '<div style="padding: 20px; text-align: center; color: #888;">该模式下暂无视频</div>';
                    return;
                }

                filteredList.forEach((item, idx) => {
                    const row = document.createElement('div');
                    const isCurrent = item.id === currentId;
                    row.innerText = `${idx + 1}. ${item.title}`;
                    row.style = `
                        padding: 10px 8px; border-bottom: 1px solid #333; cursor: pointer;
                        color: ${isCurrent ? '#4caf50' : '#ddd'};
                        background: ${isCurrent ? '#2a2a2a' : 'transparent'};
                        font-weight: ${isCurrent ? 'bold' : 'normal'};
                        transition: all 0.2s; line-height: 1.4; word-break: break-all; border-radius: 4px; margin-bottom: 2px;
                    `;
                    if (isCurrent) setTimeout(() => row.scrollIntoView({block: "center", behavior: "smooth"}), 150);
                    row.onmouseover = () => { if(!isCurrent) { row.style.color = '#fff'; row.style.background = '#444'; } };
                    row.onmouseout = () => { if(!isCurrent) { row.style.color = '#ddd'; row.style.background = 'transparent'; } };
                    row.onclick = () => { Core.jump(item.id); modal.remove(); };
                    listContainer.appendChild(row);
                });
            };

            toggleBtn.onclick = () => {
                currentMode = currentMode === 'new' ? 'old' : 'new';
                localStorage.setItem(MODE_KEY, currentMode);
                render();
            };
            render();
        },

        showDownloadPanel: function(fullList) {
            const { modal } = UI.createBaseModal("批量下载 (当前模式)", 380);
            modal.id = 'xjtu-helper-dl-modal';
            const filteredList = Core.getFilteredList(fullList);

            const controlBar = document.createElement('div');
            controlBar.style = "padding: 15px; border-bottom: 1px solid #444; background: #2a2a2a;";

            // ★ 修改UI：突出 TXT 导出按钮
            controlBar.innerHTML = `
                <div style="margin-bottom: 10px; font-weight: bold; color: #ccc;">机位选择:</div>
                <div style="display:flex; gap: 15px; margin-bottom: 15px;">
                    <label style="cursor:pointer;"><input type="checkbox" id="xjtu-dl-t1" value="INSTRUCTOR" checked> 老师机位</label>
                    <label style="cursor:pointer;"><input type="checkbox" id="xjtu-dl-t2" value="ENCODER" checked> 电脑屏幕</label>
                </div>
                <div style="display:flex; gap: 10px; justify-content: space-between;">
                    <div>
                        <button id="xjtu-dl-btn-all" style="background:#555; border:none; color:#fff; padding:6px 10px; border-radius:4px; cursor:pointer;">全选</button>
                        <button id="xjtu-dl-btn-rev" style="background:#555; border:none; color:#fff; padding:6px 10px; border-radius:4px; cursor:pointer;">反选</button>
                    </div>
                    <div style="display:flex; gap: 8px;">
                        <button id="xjtu-dl-btn-auto" style="background:#d63031; border:none; color:#fff; padding:6px 8px; border-radius:4px; cursor:pointer; font-size: 12px;" title="受跨域限制，易下载为0KB">浏览器下载</button>
                        <button id="xjtu-dl-btn-txt" style="background:#0984e3; border:none; color:#fff; padding:6px 12px; border-radius:4px; cursor:pointer; font-weight:bold; box-shadow: 0 0 8px rgba(9, 132, 227, 0.6);">导出 TXT (推荐)</button>
                    </div>
                </div>
                <div id="xjtu-dl-status" style="margin-top: 10px; font-size: 12px; color: #00cec9; height: 16px;"></div>
                <div style="margin-top: 8px; font-size: 11px; color: #888;">提示: 导出 TXT 后，在 IDM 中选择 "任务" -> "导入" -> "从文本文件导入" 即可满速批量下载。</div>
            `;
            modal.appendChild(controlBar);

            const listContainer = document.createElement('div');
            listContainer.style = "flex: 1; overflow-y: auto; padding: 10px; scrollbar-width: thin;";
            modal.appendChild(listContainer);
            document.body.appendChild(modal);

            const checkboxes = [];
            filteredList.forEach((item, idx) => {
                const row = document.createElement('label');
                row.style = "display: flex; align-items: flex-start; gap: 8px; padding: 8px; border-bottom: 1px dashed #444; cursor: pointer; transition: background 0.2s;";
                row.onmouseover = () => row.style.background = '#333';
                row.onmouseout = () => row.style.background = 'transparent';

                const cb = document.createElement('input');
                cb.type = "checkbox";
                cb.value = item.id;
                cb.style.marginTop = "3px";

                const title = document.createElement('div');
                title.innerText = `${idx + 1}. ${item.title}`;
                title.style.flex = "1";
                title.style.lineHeight = "1.3";

                row.appendChild(cb);
                row.appendChild(title);
                listContainer.appendChild(row);
                checkboxes.push({ data: item, el: cb });
            });

            document.getElementById('xjtu-dl-btn-all').onclick = () => checkboxes.forEach(c => c.el.checked = true);
            document.getElementById('xjtu-dl-btn-rev').onclick = () => checkboxes.forEach(c => c.el.checked = !c.el.checked);

            const getSelectedData = () => {
                let types = [];
                if(document.getElementById('xjtu-dl-t1').checked) types.push("INSTRUCTOR");
                if(document.getElementById('xjtu-dl-t2').checked) types.push("ENCODER");
                if(types.length === 0) { alert("至少要选择一种机位！"); return null; }

                let selectedItems = checkboxes.filter(c => c.el.checked).map(c => c.data);
                if(selectedItems.length === 0) { alert("请在列表中勾选要下载的视频！"); return null; }

                return { types, selectedItems };
            };

            const statusCb = (text) => { document.getElementById('xjtu-dl-status').innerText = text; };

            document.getElementById('xjtu-dl-btn-txt').onclick = async () => {
                const req = getSelectedData(); if(!req) return;
                let tasks = await Downloader.collectUrls(req.selectedItems, req.types, statusCb);
                Downloader.exportTxt(tasks);
                statusCb("TXT 导出完成！赶快去 IDM 导入吧。");
            };

            document.getElementById('xjtu-dl-btn-auto').onclick = async () => {
                const req = getSelectedData(); if(!req) return;
                if(!confirm(`提醒：大文件跨域下载容易被浏览器拦截变为 0KB。\n强烈建议使用右侧的【导出 TXT】结合 IDM 使用。\n您确定要继续用浏览器下载吗？`)) return;
                let tasks = await Downloader.collectUrls(req.selectedItems, req.types, statusCb);
                Downloader.browserDownload(tasks, statusCb);
            };
        },

        createBtnForControlBar: function(text, handler, targetBtn) {
            const btn = document.createElement('span');
            btn.className = targetBtn.className;
            btn.style.marginRight = "15px";
            btn.style.cursor = "pointer";
            btn.innerText = text;
            btn.onclick = (e) => { e.stopPropagation(); handler(); };
            return btn;
        },

        createFloatingFallback: function() {
            if (document.getElementById('xjtu-fallback-panel')) return;
            const panel = document.createElement('div');
            panel.id = 'xjtu-fallback-panel';
            panel.style = `
                position: fixed; right: 0; top: 50%; transform: translateY(-50%);
                background: rgba(20,20,20,0.85); padding: 15px 12px; border-radius: 8px 0 0 8px;
                z-index: 2147483647; display: flex; flex-direction: column; gap: 15px;
                box-shadow: -2px 0 10px rgba(0,0,0,0.6); backdrop-filter: blur(4px);
            `;

            const btnStyle = "color:#fff; cursor:pointer; font-size:14px; text-align:center; user-select:none; font-weight:bold; border-bottom:1px solid #555; padding-bottom:10px; transition: color 0.2s;";

            const listBtn = document.createElement('div');
            listBtn.innerText = "分集\n列表";
            listBtn.style = btnStyle;
            listBtn.onmouseover = () => listBtn.style.color = '#4caf50';
            listBtn.onmouseout = () => listBtn.style.color = '#fff';
            listBtn.onclick = () => Core.getData((list) => UI.showList(list));

            const dlBtn = document.createElement('div');
            dlBtn.innerText = "批量\n下载";
            dlBtn.style = btnStyle;
            dlBtn.onmouseover = () => dlBtn.style.color = '#0984e3';
            dlBtn.onmouseout = () => dlBtn.style.color = '#fff';
            dlBtn.onclick = () => Core.getData((list) => UI.showDownloadPanel(list));

            const nextBtn = document.createElement('div');
            nextBtn.innerText = "下一集";
            nextBtn.style = btnStyle + "border:none; padding-bottom:0;";
            nextBtn.onmouseover = () => nextBtn.style.color = '#4caf50';
            nextBtn.onmouseout = () => nextBtn.style.color = '#fff';
            nextBtn.onclick = () => {
                Core.getData((fullList) => {
                    const list = Core.getFilteredList(fullList);
                    const currId = Core.getCurrentActivityId();
                    const idx = list.findIndex(i => i.id === currId);
                    if (idx !== -1 && idx + 1 < list.length) Core.jump(list[idx + 1].id);
                    else if (idx === -1) alert("当前播放的视频不在所选模式的列表中，请打开列表切换版本。");
                    else alert("这已经是该模式下的最后一集了！");
                });
            };

            panel.appendChild(listBtn);
            panel.appendChild(dlBtn);
            panel.appendChild(nextBtn);
            document.body.appendChild(panel);
        }
    };

    // --- 启动流程 ---
    function init() {
        if (!Core.getCourseId()) return;
        Core.getData(() => {});

        let attempts = 0;
        const timer = setInterval(() => {
            attempts++;
            const target = getTargetBtnDeep();

            if (target && target.parentNode) {
                if (target.parentNode.querySelector('#xjtu-helper-flag')) return;
                clearInterval(timer);

                const flag = document.createElement('span');
                flag.id = 'xjtu-helper-flag';
                flag.style.display = 'none';
                target.parentNode.appendChild(flag);

                const dlBtn = UI.createBtnForControlBar("下载", () => {
                    Core.getData((list) => UI.showDownloadPanel(list));
                }, target);

                const listBtn = UI.createBtnForControlBar("分集", () => {
                    Core.getData((list) => UI.showList(list));
                }, target);

                const nextBtn = UI.createBtnForControlBar("下一集", () => {
                    Core.getData((fullList) => {
                        const list = Core.getFilteredList(fullList);
                        const currId = Core.getCurrentActivityId();
                        const idx = list.findIndex(i => i.id === currId);

                        if (idx !== -1 && idx + 1 < list.length) Core.jump(list[idx + 1].id);
                        else if (idx === -1) alert("当前播放的视频不在所选模式的列表中，请在分集界面切换模式后再试");
                        else alert("这已经是该模式下的最后一集了！");
                    });
                }, target);

                target.parentNode.insertBefore(nextBtn, target);
                target.parentNode.insertBefore(listBtn, nextBtn);
                target.parentNode.insertBefore(dlBtn, listBtn);
            } else if (attempts >= 10) {
                clearInterval(timer);
                UI.createFloatingFallback();
            }
        }, 1000);
    }

    init();
})();
