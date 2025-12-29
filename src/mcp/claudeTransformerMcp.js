const { MCP_SWITCH_SIGNAL, isMcpSwitchEnabled } = require("./mcpSwitchFlag");

function hasMcpTools(claudeReq) {
  return (
    Array.isArray(claudeReq?.tools) &&
    claudeReq.tools.some((tool) => typeof tool?.name === "string" && tool.name.startsWith("mcp__"))
  );
}

function buildMcpToolNamesForHint(claudeReq) {
  const tools = Array.isArray(claudeReq?.tools) ? claudeReq.tools : [];
  const servers = new Set();
  for (const tool of tools) {
    const name = tool?.name;
    if (typeof name !== "string" || !name.startsWith("mcp__")) continue;
    const parts = name.split("__");
    if (parts.length >= 3 && parts[0] === "mcp" && parts[1]) servers.add(parts[1]);
  }
  const patterns = Array.from(servers)
    .sort()
    .map((server) => `mcp__${server}__*`);
  return patterns.length > 0 ? patterns.join("、") : "mcp__*";
}

function buildMcpSwitchModelHint(claudeReq) {
  const mcpToolNamesForHint = buildMcpToolNamesForHint(claudeReq);
  return (
    `IMPORTANT（MCP 工具使用规则）\n` +
    `当前会话提供了 MCP 工具（名称以 \`mcp__\` 开头，例如：${mcpToolNamesForHint}）。\n` +
    `由于在当前链路下你直接调用任何 \`mcp__*\` 工具会导致严重异常：\n\n` +
    `注意：部分客户端可能会在每次 \`tool_result\` 之后重复附带同一句“任务指令”文本（例如“测试 Chrome DevTools…”）。\n` +
    `如果你看到某条 user 消息里包含 \`tool_result\`，并在其后重复了与上一轮用户任务指令完全一致（忽略空白）的文本，这只是“上下文回显”，不是新任务；请继续当前进度，不要重新开始。\n\n` +
    `规则：\n` +
    `1) 你可以先完成一些非 MCP 的准备工作（例如 Bash/Read/TodoWrite 等）。\n` +
    `2) 当且仅当你“下一步”需要调用任意 \`mcp__*\` 工具时：严禁直接调用工具；也严禁输出其它任何内容（包括解释、计划、TodoWrite、markdown）。\n` +
    `   即使你在本会话中曾成功调用过 \`mcp__*\` 工具，也必须严格遵守以上规则。\n` +
    `3) 此时你必须只输出下面这一行特殊字符串（完全一致，单独一行，不要添加任何前后缀/标点/空格/其它字符）：\n` +
    `${MCP_SWITCH_SIGNAL}\n\n` +
    `如果不需要使用 \`mcp__*\` 工具，请正常回答用户。`
  );
}

function maybeInjectMcpHintIntoSystemText({ text, claudeReq, isClaudeModel, injected }) {
  if (!isMcpSwitchEnabled()) return { text, injected };
  if (!isClaudeModel) return { text, injected };
  // 如果本轮上游模型已经是 gemini（例如 gemini-3-flash / gemini-3-flash-preview），
  // 就不应该再注入“输出切换信号”的提示词（否则会导致 gemini 也被强制只输出 MCP_SWITCH_SIGNAL）。
  const rawModel = typeof claudeReq?.model === "string" ? claudeReq.model.trim() : "";
  if (rawModel.startsWith("gemini-") || rawModel.startsWith("models/gemini-")) {
    return { text, injected };
  }
  if (!hasMcpTools(claudeReq)) return { text, injected };
  if (typeof text !== "string" || !text.includes("mcp__")) return { text, injected };

  let nextText = text;

  // Remove explicit mcp__ tool names from system text, avoiding partial prefix stripping.
  for (const tool of Array.isArray(claudeReq?.tools) ? claudeReq.tools : []) {
    const name = tool?.name;
    if (typeof name === "string" && name.startsWith("mcp__")) {
      nextText = nextText.replaceAll(name, "");
    }
  }

  // Cleanup separators after deletions (commas/whitespace).
  nextText = nextText
    .replace(/,\s*,/g, ", ")
    .replace(/,\s*\n/g, "\n")
    .replace(/,\s*\)/g, ")")
    .replace(/\(\s*,/g, "(")
    .replace(/\s+,/g, ",")
    .replace(/,\s*$/gm, "")
    .replace(/ {2,}/g, " ");

  if (!injected) {
    nextText = `${nextText}\n\n${buildMcpSwitchModelHint(claudeReq)}`;
    return { text: nextText, injected: true };
  }

  return { text: nextText, injected };
}

module.exports = {
  maybeInjectMcpHintIntoSystemText,
};
