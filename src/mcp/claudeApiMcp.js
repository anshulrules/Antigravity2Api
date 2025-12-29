const { transformClaudeRequestIn, transformClaudeResponseOut, mapClaudeModelToGemini } = require("../transform/claude");
const { MCP_SWITCH_SIGNAL } = require("./mcpSwitchFlag");

function inferClaudeCodeModelFromSystem(claudeReq) {
  const system = Array.isArray(claudeReq?.system) ? claudeReq.system : [];
  for (const item of system) {
    const text = item?.text;
    if (typeof text !== "string" || text.length === 0) continue;
    // Claude Code includes: "You are powered by the model named Opus 4.5. The exact model ID is claude-opus-4-5-thinking."
    const exact = text.match(/The exact model ID is ([a-zA-Z0-9._-]+)\./);
    if (exact && exact[1] && exact[1].startsWith("claude-")) return exact[1];
  }
  return null;
}

function hasMcpTools(claudeReq) {
  return (
    Array.isArray(claudeReq?.tools) &&
    claudeReq.tools.some((tool) => typeof tool?.name === "string" && tool.name.startsWith("mcp__"))
  );
}

function getSessionId(claudeReq) {
  const id = claudeReq?.metadata?.user_id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function ensureSessionState(sessionMcpState, claudeReq) {
  const sessionId = getSessionId(claudeReq);
  if (!sessionId) return null;

  let sessionState = sessionMcpState.get(sessionId);
  if (!sessionState) {
    sessionState = { lastFamily: null, mcpStartIndex: null, foldedSegments: [] };
    sessionMcpState.set(sessionId, sessionState);
  }
  return sessionState;
}

function collectToolResultIdsAfterLastAssistant(claudeReq) {
  if (!Array.isArray(claudeReq?.messages) || claudeReq.messages.length === 0) return new Set();

  // Only treat it as a tool_result "turn" if the tool_result appears after the last assistant message.
  // Claude requests include history, so scanning the whole messages[] would incorrectly stick forever.
  let lastAssistantIndex = -1;
  for (let i = claudeReq.messages.length - 1; i >= 0; i--) {
    if (claudeReq.messages[i]?.role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }

  const startIndex = lastAssistantIndex >= 0 ? lastAssistantIndex + 1 : 0;
  const toolUseIds = new Set();
  for (let i = startIndex; i < claudeReq.messages.length; i++) {
    const msg = claudeReq.messages[i];
    if (!Array.isArray(msg?.content)) continue;
    for (const item of msg.content) {
      if (item && item.type === "tool_result" && typeof item.tool_use_id === "string" && item.tool_use_id) {
        toolUseIds.add(item.tool_use_id);
      }
    }
  }

  return toolUseIds;
}

function hasAnyToolResultTurn(claudeReq) {
  return collectToolResultIdsAfterLastAssistant(claudeReq).size > 0;
}

function isMcpToolResultTurn(claudeReq, sessionState) {
  const toolUseIds = collectToolResultIdsAfterLastAssistant(claudeReq);
  if (toolUseIds.size === 0) return false;

  // Only treat it as an MCP tool_result turn if the referenced tool_use is an MCP tool.
  // This prevents unrelated gemini requests (e.g. web_search/topic title) from forcing MCP routing.
  let matchedAnyToolUse = false;
  for (let i = claudeReq.messages.length - 1; i >= 0; i--) {
    const msg = claudeReq.messages[i];
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const item of msg.content) {
      if (!item || item.type !== "tool_use") continue;
      if (!toolUseIds.has(item.id)) continue;
      matchedAnyToolUse = true;
      if (typeof item.name === "string" && item.name.startsWith("mcp__")) return true;
      // If this tool_use was produced during an active MCP segment, keep routing its tool_result back
      // to the MCP model to avoid cross-model signature and toolchain issues (even for non-mcp__ tools
      // like TodoWrite that might have been emitted by the MCP model).
      if (sessionState?.mcpStartIndex != null && i >= sessionState.mcpStartIndex) return true;
    }
  }

  if (matchedAnyToolUse) return false;

  // Fallback: if we can't find the tool_use in history but we are in an active MCP segment, keep routing
  // to MCP to avoid breaking an ongoing MCP toolchain.
  return sessionState?.mcpStartIndex != null;
}

function extractTextFromClaudeContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

function extractLastAssistantText(messages, startIndex, endIndexExclusive) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const start = Math.max(0, startIndex || 0);
  const end = Math.min(messages.length, endIndexExclusive ?? messages.length);
  for (let i = end - 1; i >= start; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;
    const text = extractTextFromClaudeContent(msg.content);
    if (text && text.trim()) return text.trim();
  }
  return "";
}

function foldSegments(messages, segments) {
  if (!Array.isArray(messages) || messages.length === 0) return messages || [];
  if (!Array.isArray(segments) || segments.length === 0) return messages;

  const sorted = [...segments]
    .filter((s) => Number.isInteger(s?.start) && Number.isInteger(s?.end) && s.start >= 0 && s.end > s.start)
    .sort((a, b) => a.start - b.start);

  if (sorted.length === 0) return messages;

  const out = [];
  let i = 0;
  for (const seg of sorted) {
    while (i < messages.length && i < seg.start) out.push(messages[i++]);

    const summary = typeof seg.summaryText === "string" ? seg.summaryText.trim() : "";
    if (summary) {
      out.push({
        role: "user",
        content: [{ type: "text", text: `MCP result:\n${summary}` }],
      });
    }

    i = Math.max(i, seg.end);
  }

  while (i < messages.length) out.push(messages[i++]);
  return out;
}

async function readStreamToString(stream) {
  if (!stream || typeof stream.getReader !== "function") return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

function streamFromString(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text || ""));
      controller.close();
    },
  });
}

function hasMcpSwitchSignal(transformedSseText) {
  const chunks = String(transformedSseText || "").split("\n\n");
  let textOut = "";
  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    const dataLine = lines.find((l) => l.startsWith("data: "));
    if (!dataLine) continue;
    const payload = dataLine.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch (_) {
      continue;
    }
    // Strong trigger: model attempted to call an MCP tool (e.g. mcp__serena__*, mcp__chrome-devtools__*).
    // Do not rely on prompt compliance.
    if (
      obj?.type === "content_block_start" &&
      obj?.content_block?.type === "tool_use" &&
      typeof obj?.content_block?.name === "string" &&
      obj.content_block.name.startsWith("mcp__")
    ) {
      return true;
    }
    if (obj?.type === "content_block_delta") {
      const delta = obj?.delta;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        textOut += delta.text;
      }
    }
  }
  return textOut.includes(MCP_SWITCH_SIGNAL);
}

function headersToObject(headers) {
  const out = {};
  if (!headers || typeof headers.forEach !== "function") return out;
  headers.forEach((value, key) => {
    out[key] = value;
  });
  delete out["content-encoding"];
  delete out["content-length"];
  return out;
}

function prepareMcpContext({ requestData, sessionMcpState, mcpModel, inferFinalModelForQuota }) {
  const sessionState = ensureSessionState(sessionMcpState, requestData);

  const baseModel = inferClaudeCodeModelFromSystem(requestData) || requestData.model;
  const isMcpResultTurn = isMcpToolResultTurn(requestData, sessionState);
  const upstreamRequest = { ...requestData, model: isMcpResultTurn ? mcpModel : baseModel };
  const shouldBufferForSwitch =
    !!requestData.stream &&
    !isMcpResultTurn &&
    hasMcpTools(requestData) &&
    String(mapClaudeModelToGemini(baseModel)).startsWith("claude");

  const modelForQuota = isMcpResultTurn ? mcpModel : inferFinalModelForQuota({ ...requestData, model: baseModel });

  // If we are switching back from MCP (Gemini) to Claude, fold the MCP segment out of upstream history
  // to avoid carrying incompatible thought/signature blocks across models.
  let upstreamRequestForTransform = upstreamRequest;
  if (sessionState && Array.isArray(requestData.messages)) {
    const targetFamily = String(modelForQuota || "").toLowerCase().includes("claude") ? "claude" : "gemini";

    if (targetFamily === "claude" && sessionState.mcpStartIndex != null) {
      const end = Math.max(0, requestData.messages.length - 1); // keep last user message
      const start = Math.max(0, sessionState.mcpStartIndex);
      if (end > start) {
        const summaryText = extractLastAssistantText(requestData.messages, start, end);
        sessionState.foldedSegments.push({ start, end, summaryText });
      }
      sessionState.mcpStartIndex = null;
    }

    if (targetFamily === "claude" && sessionState.foldedSegments.length > 0) {
      upstreamRequestForTransform = {
        ...upstreamRequestForTransform,
        messages: foldSegments(requestData.messages, sessionState.foldedSegments),
      };
    }
  }

  // 当本轮上游使用 gemini（MCP）模型时：
  // - 为避免把 Claude 段的 thoughtSignature / thought=true 带进 Gemini 导致 Corrupted signature，
  //   仅转发 MCP 段（messages[>=mcpStartIndex]）内的签名；首次进入 MCP 段时 mcpStartIndex 尚未设置，
  //   则使用 messages.length（等价于本轮不转发任何历史签名）。
  //
  // 方案 A：如果本轮本来就是 Gemini（例如 Claude Code 的 subagent 直接用 gemini-*），
  // 则不启用“签名分段转发”，保持正常转发签名（否则 Gemini 会因缺少 thought_signature 拒绝 functionCall）。
  const targetFamily = String(modelForQuota || "").toLowerCase().includes("claude") ? "claude" : "gemini";
  const baseFamilyIsClaude = String(mapClaudeModelToGemini(baseModel)).startsWith("claude");
  const transformOptions =
    baseFamilyIsClaude && targetFamily === "gemini" && Array.isArray(upstreamRequestForTransform?.messages)
      ? {
          signatureSegmentStartIndex:
            sessionState?.mcpStartIndex != null ? sessionState.mcpStartIndex : upstreamRequestForTransform.messages.length,
        }
      : undefined;

  return {
    baseModel,
    modelForQuota,
    upstreamRequestForTransform,
    shouldBufferForSwitch,
    transformOptions,
    sessionState,
  };
}

function updateSessionAfterResponse({ sessionState, requestData, baseModel, modelForQuota, mcpModel }) {
  if (!sessionState) return;

  const finalFamily = String(modelForQuota || "").toLowerCase().includes("claude") ? "claude" : "gemini";
  sessionState.lastFamily = finalFamily;
  if (
    String(mapClaudeModelToGemini(baseModel)).startsWith("claude") &&
    modelForQuota === mcpModel &&
    sessionState.mcpStartIndex == null &&
    Array.isArray(requestData.messages)
  ) {
    // MCP segment begins after this request's last message; the next request will include the new assistant msg.
    sessionState.mcpStartIndex = requestData.messages.length;
  }
}

async function bufferForMcpSwitchAndMaybeRetry({
  upstream,
  method,
  queryString,
  requestData,
  baseModel,
  mcpModel,
  convertedResponse,
  shouldBufferForSwitch,
  debugRequestResponse,
  log,
  logDebug,
  logStreamContent,
  sessionState,
}) {
  if (!shouldBufferForSwitch || !convertedResponse?.body) return null;

  const buffered = await readStreamToString(convertedResponse.body);
  if (debugRequestResponse && buffered) {
    log("Claude Response Payload (Transformed Stream)", buffered);
  }

  if (!hasMcpSwitchSignal(buffered)) {
    return { finalResponseBody: streamFromString(buffered) };
  }

  log("info", `MCP switch signal detected; retrying upstream with ${mcpModel}`);

  let retryLoggedTransformed = false;
  const retryResp = await upstream.callV1Internal(method, {
    model: mcpModel,
    queryString,
    buildBody: (projectId) => {
      const signatureSegmentStartIndex = Array.isArray(requestData?.messages) ? requestData.messages.length : 0;
      const { body: googleBody } = transformClaudeRequestIn({ ...requestData, model: mcpModel }, projectId, {
        signatureSegmentStartIndex,
      });
      if (!retryLoggedTransformed) {
        logDebug("Gemini Payload Request (Transformed, Retry MCP)", googleBody);
        retryLoggedTransformed = true;
      }
      return googleBody;
    },
  });

  if (!retryResp.ok) {
    const headers = headersToObject(retryResp.headers);
    let body = retryResp.body;

    if (debugRequestResponse && retryResp.body) {
      try {
        if (typeof retryResp.body.tee === "function") {
          const [logBranch, processBranch] = retryResp.body.tee();
          logStreamContent(logBranch, `Upstream Error Raw (Stream, Retry MCP, HTTP ${retryResp.status})`);
          body = processBranch;
        } else {
          const errorText = await retryResp.clone().text().catch(() => "");
          if (errorText) log(`Upstream Error Body (Retry MCP, HTTP ${retryResp.status})`, errorText);
        }
      } catch (e) {
        log("warn", `Failed to log retry upstream error body: ${e.message || e}`);
      }
    }

    return { apiResponse: { status: retryResp.status, headers, body } };
  }

  // Log Gemini response raw stream (retry)
  let retryForTransform = retryResp;
  if (debugRequestResponse && retryResp.body) {
    try {
      const [logBranch, processBranch] = retryResp.body.tee();
      logStreamContent(logBranch, "Gemini Response Raw (Stream, Retry MCP)");
      retryForTransform = new Response(processBranch, {
        status: retryResp.status,
        statusText: retryResp.statusText,
        headers: retryResp.headers,
      });
    } catch (e) {
      log("Error teeing retry stream for logging", e.message || e);
    }
  }

  const retryConverted = await transformClaudeResponseOut(retryForTransform, { overrideModel: baseModel });
  let retryBody = retryConverted.body;

  if (debugRequestResponse && retryConverted.body) {
    try {
      const [logBranch, processBranch] = retryConverted.body.tee();
      logStreamContent(logBranch, "Claude Response Payload (Transformed Stream, Retry MCP)");
      retryBody = processBranch;
    } catch (e) {
      log("Error teeing retry converted stream for logging", e.message || e);
    }
  }

  if (sessionState) {
    sessionState.lastFamily = "gemini";
    if (sessionState.mcpStartIndex == null && Array.isArray(requestData.messages)) {
      // MCP segment begins after this request's last message; the next request will include the new assistant msg.
      sessionState.mcpStartIndex = requestData.messages.length;
    }
  }

  return {
    apiResponse: {
      status: retryConverted.status,
      headers: {
        "Content-Type": retryConverted.headers.get("Content-Type") || "application/json",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
      body: retryBody,
    },
  };
}

module.exports = {
  prepareMcpContext,
  bufferForMcpSwitchAndMaybeRetry,
  updateSessionAfterResponse,
};
