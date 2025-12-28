(function () {
  const $ = (id) => document.getElementById(id);

  const els = {
    apiKey: $("apiKey"),
    btnSaveKey: $("btnSaveKey"),
    btnClearKey: $("btnClearKey"),
    keyStatus: $("keyStatus"),
    btnReload: $("btnReload"),
    btnAdd: $("btnAdd"),
    oauthStatus: $("oauthStatus"),
    oauthUrl: $("oauthUrl"),
    oauthState: $("oauthState"),
    btnCopyUrl: $("btnCopyUrl"),
    oauthPaste: $("oauthPaste"),
    btnSubmitCallback: $("btnSubmitCallback"),
    accountsBody: $("accountsBody"),
    accountsMeta: $("accountsMeta"),
    quotaModal: $("quotaModal"),
    quotaClose: $("quotaClose"),
    quotaBody: $("quotaBody"),
    versionBar: $("versionBar"),
    versionLocal: $("versionLocal"),
    versionUpdate: $("versionUpdate"),
  };

  const state = {
    apiKey: "",
    oauth: { state: null, url: null },
  };

  let oauthPollTimer = null;

  function setStatus(text, type = "info") {
    const prefix = type === "error" ? "❌ " : type === "success" ? "✅ " : "ℹ️ ";
    els.keyStatus.textContent = prefix + text;
  }

  function closeQuotaModal() {
    els.quotaModal.classList.remove("open");
  }

  function renderQuotaTable(data) {
    if (!data || data.length === 0) {
      els.quotaBody.innerHTML = '<div style="padding: 20px;">未查询到相关模型额度信息。</div>';
      return;
    }
    let html = '<table class="table" style="min-width: 100%;"><thead><tr><th>模型</th><th>剩余</th><th>重置时间</th></tr></thead><tbody>';
    for (const item of data) {
      html += `<tr>
            <td class="mono">${item.model}</td>
            <td>${item.limit}</td>
            <td>${item.reset}</td>
        </tr>`;
    }
    html += '</tbody></table>';
    els.quotaBody.innerHTML = html;
  }

  function loadApiKey() {
    try {
      const saved = localStorage.getItem("admin_api_key") || "";
      state.apiKey = saved;
      els.apiKey.value = saved;
      if (saved) setStatus("已加载本地保存的 API Key", "success");
      else setStatus("未设置 API Key（如果服务端配置了 api_keys，调用会 401）", "info");
    } catch (e) {
      setStatus("无法读取 localStorage", "error");
    }
  }

  function saveApiKey() {
    state.apiKey = (els.apiKey.value || "").trim();
    try {
      localStorage.setItem("admin_api_key", state.apiKey);
      setStatus(state.apiKey ? "API Key 已保存" : "API Key 已清空", "success");
    } catch (e) {
      setStatus("保存失败（localStorage 不可用）", "error");
    }
  }

  function clearApiKey() {
    els.apiKey.value = "";
    state.apiKey = "";
    try {
      localStorage.removeItem("admin_api_key");
    } catch (e) {}
    setStatus("已清除 API Key", "success");
  }

  async function apiFetch(path, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    if (state.apiKey) headers["x-api-key"] = state.apiKey;
    if (!headers["Content-Type"] && options.method && options.method !== "GET") {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(path, Object.assign({}, options, { headers }));
    const contentType = res.headers.get("Content-Type") || "";
    const isJson = contentType.includes("application/json");
    const data = isJson ? await res.json().catch(() => null) : await res.text().catch(() => "");
    if (!res.ok) {
      const msg = data?.error?.message || data?.message || (typeof data === "string" ? data : `HTTP ${res.status}`);
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function formatExpiry(expiryDateMs) {
    if (!expiryDateMs) return "-";
    try {
      const d = new Date(expiryDateMs);
      if (Number.isNaN(d.getTime())) return "-";
      return d.toLocaleString();
    } catch (e) {
      return "-";
    }
  }

  function renderAccounts(payload) {
    const { count, current, accounts } = payload || {};
    const total = count || 0;
    const claudeIndex = total > 0 ? (current?.claude ?? 0) + 1 : 0;
    const geminiIndex = total > 0 ? (current?.gemini ?? 0) + 1 : 0;
    els.accountsMeta.textContent = `账号数: ${total}；当前索引 claude=${claudeIndex} / gemini=${geminiIndex}`;

    els.accountsBody.innerHTML = "";
    if (!accounts || accounts.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 5;
      td.textContent = "暂无账号，请先点击 “OAuth 添加账号”。";
      tr.appendChild(td);
      els.accountsBody.appendChild(tr);
      return;
    }

    for (const acc of accounts) {
      const tr = document.createElement("tr");

      const fileTd = document.createElement("td");
      fileTd.className = "mono";
      fileTd.textContent = acc.file || "-";

      const emailTd = document.createElement("td");
      emailTd.textContent = acc.email || "-";

      const pidTd = document.createElement("td");
      pidTd.className = "mono";
      pidTd.textContent = acc.projectId || "-";

      const expTd = document.createElement("td");
      expTd.textContent = formatExpiry(acc.expiry_date);

      const actTd = document.createElement("td");

      const quotaBtn = document.createElement("button");
      quotaBtn.className = "btn small";
      quotaBtn.style.marginRight = "6px";
      quotaBtn.textContent = "额度";
      quotaBtn.addEventListener("click", async () => {
        els.quotaModal.classList.add("open");
        els.quotaBody.innerHTML = '<div class="loading-spinner">加载中...</div>';
        try {
          const res = await apiFetch(`/admin/api/accounts/${encodeURIComponent(acc.file)}/quota`, { method: "GET" });
          renderQuotaTable(res.data);
        } catch (e) {
          els.quotaBody.innerHTML = `<div style="color: #ff6b6b; padding: 20px;">加载失败：${e.message || e}</div>`;
        }
      });
      actTd.appendChild(quotaBtn);

      const delBtn = document.createElement("button");
      delBtn.className = "btn small danger";
      delBtn.textContent = "删除";
      delBtn.addEventListener("click", async () => {
        if (!acc.file) return;
        const ok = confirm(`确认删除账号文件：${acc.file} ？`);
        if (!ok) return;
        try {
          await apiFetch(`/admin/api/accounts/${encodeURIComponent(acc.file)}`, { method: "DELETE" });
          await refreshAccounts();
        } catch (e) {
          alert(`删除失败：${e.message || e}`);
        }
      });
      actTd.appendChild(delBtn);

      tr.appendChild(fileTd);
      tr.appendChild(emailTd);
      tr.appendChild(pidTd);
      tr.appendChild(expTd);
      tr.appendChild(actTd);
      els.accountsBody.appendChild(tr);
    }
  }

  async function refreshAccounts() {
    try {
      const res = await apiFetch("/admin/api/accounts", { method: "GET" });
      renderAccounts(res.data);
    } catch (e) {
      if (e.status === 401) {
        els.accountsMeta.textContent = "未授权：请先输入正确的 API Key";
        els.accountsBody.innerHTML = "";
        return;
      }
      els.accountsMeta.textContent = `加载失败：${e.message || e}`;
      els.accountsBody.innerHTML = "";
    }
  }

  function setOAuthInfo({ status, url, stateId }) {
    els.oauthStatus.textContent = status || "-";
    els.oauthState.textContent = stateId || "-";
    if (url) {
      els.oauthUrl.textContent = url;
      els.oauthUrl.href = url;
    } else {
      els.oauthUrl.textContent = "-";
      els.oauthUrl.href = "#";
    }
  }

  function stopOAuthPolling() {
    if (oauthPollTimer) {
      clearInterval(oauthPollTimer);
      oauthPollTimer = null;
    }
  }

  async function pollOAuthStatusOnce() {
    if (!state.oauth.state) return;
    try {
      const res = await apiFetch(`/admin/api/oauth/status/${encodeURIComponent(state.oauth.state)}`, {
        method: "GET",
      });
      const data = res.data;
      if (!data || !data.status) return;

      if (data.status === "pending") {
        setOAuthInfo({ status: "等待授权回调...", url: state.oauth.url, stateId: state.oauth.state });
        return;
      }

      if (data.status === "expired") {
        stopOAuthPolling();
        setOAuthInfo({ status: `授权已过期：${data.message || ""}`, url: state.oauth.url, stateId: state.oauth.state });
        return;
      }

      if (data.status === "completed") {
        stopOAuthPolling();
        if (data.success) {
          setOAuthInfo({ status: `授权成功：${data.message || ""}`, url: state.oauth.url, stateId: state.oauth.state });
          refreshAccounts();
        } else {
          setOAuthInfo({ status: `授权失败：${data.message || ""}`, url: state.oauth.url, stateId: state.oauth.state });
        }
      }
    } catch (e) {
      // keep polling silently
    }
  }

  function startOAuthPolling() {
    stopOAuthPolling();
    oauthPollTimer = setInterval(pollOAuthStatusOnce, 2000);
  }

  async function startOAuth() {
    stopOAuthPolling();
    setOAuthInfo({ status: "生成授权链接中..." });
    try {
      const res = await apiFetch("/admin/api/oauth/start", { method: "POST", body: "{}" });
      const data = res.data;
      state.oauth.state = data.state;
      state.oauth.url = data.auth_url;
      setOAuthInfo({ status: "请在弹窗完成授权", url: data.auth_url, stateId: data.state });

      const popup = window.open(data.auth_url, "_blank");
      if (!popup) {
        setOAuthInfo({ status: "弹窗被拦截，请手动点击链接打开", url: data.auth_url, stateId: data.state });
      }

      startOAuthPolling();
    } catch (e) {
      if (e.status === 401) {
        setOAuthInfo({ status: "未授权：请先输入正确的 API Key" });
        return;
      }
      setOAuthInfo({ status: `启动失败：${e.message || e}` });
    }
  }

  function handleOAuthMessage(event) {
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.type !== "oauth_result") return;
    if (state.oauth.state && data.state && data.state !== state.oauth.state) return;

    if (data.success) {
      stopOAuthPolling();
      setOAuthInfo({ status: `授权成功：${data.message || ""}`, url: state.oauth.url, stateId: state.oauth.state });
      refreshAccounts();
    } else {
      stopOAuthPolling();
      setOAuthInfo({ status: `授权失败：${data.message || ""}`, url: state.oauth.url, stateId: state.oauth.state });
    }
  }

  async function copyOAuthUrl() {
    const url = state.oauth.url;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setOAuthInfo({ status: "已复制授权链接", url, stateId: state.oauth.state });
    } catch (e) {
      alert("复制失败，请手动复制");
    }
  }

  async function submitOAuthCallback() {
    const raw = (els.oauthPaste?.value || "").trim();
    if (!raw) {
      setOAuthInfo({ status: "请输入回调链接或授权码 code", url: state.oauth.url, stateId: state.oauth.state });
      return;
    }

    setOAuthInfo({ status: "提交授权信息中...", url: state.oauth.url, stateId: state.oauth.state });

    try {
      const body = { callback_url: raw };
      if (state.oauth.state) body.state = state.oauth.state;
      const res = await apiFetch("/admin/api/oauth/complete", { method: "POST", body: JSON.stringify(body) });
      const data = res.data || {};
      if (data.state && !state.oauth.state) state.oauth.state = data.state;

      if (data.success) {
        stopOAuthPolling();
        setOAuthInfo({ status: `授权成功：${data.message || ""}`, url: state.oauth.url, stateId: state.oauth.state });
        if (els.oauthPaste) els.oauthPaste.value = "";
        refreshAccounts();
      } else {
        setOAuthInfo({ status: `授权失败：${data.message || ""}`, url: state.oauth.url, stateId: state.oauth.state });
      }
    } catch (e) {
      if (e.status === 401) {
        setOAuthInfo({ status: "未授权：请先输入正确的 API Key" });
        return;
      }
      setOAuthInfo({ status: `提交失败：${e.message || e}`, url: state.oauth.url, stateId: state.oauth.state });
    }
  }

  function bindEvents() {
    els.btnSaveKey.addEventListener("click", () => {
      saveApiKey();
      refreshAccounts();
    });
    els.btnClearKey.addEventListener("click", () => {
      clearApiKey();
      refreshAccounts();
    });
    els.btnReload.addEventListener("click", async () => {
      try {
        await apiFetch("/admin/api/accounts/reload", { method: "POST", body: "{}" });
      } catch (e) {}
      refreshAccounts();
    });
    els.btnAdd.addEventListener("click", startOAuth);
    els.btnCopyUrl.addEventListener("click", copyOAuthUrl);
    if (els.btnSubmitCallback) {
      els.btnSubmitCallback.addEventListener("click", submitOAuthCallback);
    }
    if (els.oauthPaste) {
      els.oauthPaste.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submitOAuthCallback();
      });
    }
    window.addEventListener("message", handleOAuthMessage);
    els.quotaClose.addEventListener("click", closeQuotaModal);
    els.quotaModal.addEventListener("click", (e) => {
      if (e.target === els.quotaModal) closeQuotaModal();
    });
  }

  function normalizeVersion(value) {
    return String(value || "")
      .trim()
      .replace(/^v/i, "");
  }

  function parseDateVersionKey(value) {
    const v = normalizeVersion(value);
    const m = /^(\d{4})\.(\d{2})\.(\d{2})-t(\d{6})$/.exec(v);
    if (!m) return null;
    return `${m[1]}${m[2]}${m[3]}${m[4]}`;
  }

  function parseSemverParts(value) {
    const v = normalizeVersion(value);
    const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }

  function compareVersionStrings(localVersion, latestVersion) {
    const localKey = parseDateVersionKey(localVersion);
    const latestKey = parseDateVersionKey(latestVersion);
    if (localKey && latestKey) {
      if (latestKey === localKey) return 0;
      return latestKey > localKey ? 1 : -1;
    }

    const localSemver = parseSemverParts(localVersion);
    const latestSemver = parseSemverParts(latestVersion);
    if (localSemver && latestSemver) {
      for (let i = 0; i < 3; i++) {
        if (latestSemver[i] !== localSemver[i]) return latestSemver[i] > localSemver[i] ? 1 : -1;
      }
      return 0;
    }

    const a = normalizeVersion(localVersion);
    const b = normalizeVersion(latestVersion);
    if (!a || !b) return null;
    return a === b ? 0 : null;
  }

  function renderVersionInfo(payload) {
    if (!els.versionLocal || !els.versionUpdate) return;

    const localVersion = payload?.local?.version || "-";
    const repo = payload?.repo || "znlsl/Antigravity2Api";
    const latestTag = payload?.latest?.tag_name || null;
    const latestUrl = payload?.latest?.html_url || `https://github.com/${repo}/releases/latest`;

    els.versionLocal.textContent = `本地版本：${localVersion}`;

    els.versionUpdate.textContent = "";
    els.versionUpdate.innerHTML = "";

    if (!latestTag) return;

    const cmp = compareVersionStrings(localVersion, latestTag);
    const updateAvailable = cmp == null ? normalizeVersion(localVersion) !== normalizeVersion(latestTag) : cmp > 0;
    if (!updateAvailable) return;

    const prefix = document.createElement("span");
    prefix.textContent = "发现新版本：";

    const link = document.createElement("a");
    link.href = latestUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = latestTag;

    els.versionUpdate.appendChild(prefix);
    els.versionUpdate.appendChild(link);
  }

  async function refreshVersionInfo() {
    if (!els.versionBar || !els.versionLocal || !els.versionUpdate) return;
    els.versionLocal.textContent = "本地版本：加载中...";
    els.versionUpdate.textContent = "";
    try {
      const res = await fetch("/ui/version", { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) return;
      renderVersionInfo(data);
    } catch (e) {
      // Ignore version check errors (offline / proxy / rate-limit), UI should still work.
    }
  }

  loadApiKey();
  bindEvents();
  refreshAccounts();
  refreshVersionInfo();
})();
