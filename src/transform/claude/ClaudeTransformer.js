/**
 * ClaudeTransformer - Claude 格式请求/响应转换器
 * 
 * 基于 ThoughtSignatures Gemini API 官方文档实现
 * 支持 thinking、签名、函数调用等场景
 */

// ==================== tool_use.id -> thoughtSignature（跨 turn） ====================
// 规范要求：如果模型响应里出现 thoughtSignature，下一轮发送历史记录时必须原样带回到对应的 part。
// 但 Claude Code 下一次请求不会回传 `tool_use.signature`（非标准字段），
// 所以需要代理进程内维护一份 tool_use.id -> thoughtSignature 的映射，并在转回 v1internal 时补回。
const toolThoughtSignatures = new Map(); // tool_use.id -> thoughtSignature
const crypto = require("crypto");
const { maybeInjectMcpHintIntoSystemText } = require("../../mcp/claudeTransformerMcp");

function makeToolUseId() {
  // Claude Code expects tool_use ids to look like official "toolu_*" ids.
  return `toolu_vrtx_${crypto.randomBytes(16).toString("base64url")}`;
}

function isDebugEnabled() {
  const raw = process.env.AG2API_DEBUG;
  if (!raw) return false;
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function rememberToolThoughtSignature(toolUseId, thoughtSignature) {
  if (!toolUseId || !thoughtSignature) return;
  const id = String(toolUseId);
  const sig = String(thoughtSignature);
  toolThoughtSignatures.set(id, sig);
  if (isDebugEnabled()) console.log(`[ThoughtSignature] cached tool_use.id=${id} len=${sig.length}`);
}

function getToolThoughtSignature(toolUseId) {
  if (!toolUseId) return null;
  const id = String(toolUseId);
  return toolThoughtSignatures.get(id) || null;
}

// ==================== 签名管理器 ====================
class SignatureManager {
  constructor() {
    this.pending = null;
  }
  
  // 存储签名
  store(signature) {
    if (signature) this.pending = signature;
  }
  
  // 消费并返回签名
  consume() {
    const sig = this.pending;
    this.pending = null;
    return sig;
  }
  
  // 是否有暂存的签名
  hasPending() {
    return !!this.pending;
  }
}

// ==================== 流式状态机 ====================
class StreamingState {
  // 块类型常量
  static BLOCK_NONE = 0;
  static BLOCK_TEXT = 1;
  static BLOCK_THINKING = 2;
  static BLOCK_FUNCTION = 3;
  
  constructor(encoder, controller) {
    this.encoder = encoder;
    this.controller = controller;
    this.blockType = StreamingState.BLOCK_NONE;
    this.blockIndex = 0;
    this.messageStartSent = false;
    this.messageStopSent = false;
    this.overrideModel = null;
    this.usedTool = false;
    this.hasThinking = false;
    this.signatures = new SignatureManager();  // thinking/FC 签名
    this.trailingSignature = null;  // 空 text 带签名（必须单独用空 thinking 块承载）

    // web_search（grounding）专用：先实时输出 thinking，再在 finish 时补齐 server_tool_use / tool_result / citations / 最终文本
    this.webSearchMode = false;
    this.webSearch = {
      toolUseId: null,
      query: "",
      results: [],
      supports: [],
      bufferedTextParts: [],
    };
  }
  
  // 发送 SSE 事件
  emit(eventType, data) {
    this.controller.enqueue(
      this.encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`)
    );
  }
  
  // 发送 message_start 事件
  emitMessageStart(rawJSON) {
    if (this.messageStartSent) return;
    
    const usage = rawJSON.usageMetadata ? toClaudeUsage(rawJSON.usageMetadata) : undefined;
    
    this.emit("message_start", {
      type: "message_start",
      message: {
        id: rawJSON.responseId || "msg_" + Math.random().toString(36).substring(2),
        type: "message",
        role: "assistant",
        content: [],
        model: this.overrideModel || rawJSON.modelVersion,
        stop_reason: null,
        stop_sequence: null,
        ...(usage ? { usage } : {})
      }
    });
    this.messageStartSent = true;
  }
  
  // 开始新的内容块
  startBlock(type, contentBlock) {
    if (this.blockType !== StreamingState.BLOCK_NONE) {
      this.endBlock();
    }
    
    // Claude 官方 SSE：thinking block start 总是带 signature 字段（即便为空串）
    if (contentBlock?.type === "thinking" && !Object.prototype.hasOwnProperty.call(contentBlock, "signature")) {
      contentBlock = { ...contentBlock, signature: "" };
    }

    this.emit("content_block_start", {
      type: "content_block_start",
      index: this.blockIndex,
      content_block: contentBlock
    });
    this.blockType = type;
  }
  
  // 结束当前内容块
  endBlock() {
    if (this.blockType === StreamingState.BLOCK_NONE) return;
    
    // 如果是 thinking 块结束，先发送暂存的签名（来自 thinking part）
    if (this.blockType === StreamingState.BLOCK_THINKING && this.signatures.hasPending()) {
      this.emitDelta("signature_delta", { signature: this.signatures.consume() });
    }
    
    this.emit("content_block_stop", {
      type: "content_block_stop",
      index: this.blockIndex
    });
    this.blockIndex++;
    this.blockType = StreamingState.BLOCK_NONE;
  }
  
  // 发送 delta 事件
  emitDelta(deltaType, deltaContent) {
    this.emit("content_block_delta", {
      type: "content_block_delta",
      index: this.blockIndex,
      delta: { type: deltaType, ...deltaContent }
    });
  }
  
  // 发送结束事件
  emitFinish(finishReason, usageMetadata, extraUsage) {
    // 关闭最后一个块
    this.endBlock();
    
    // 根据官方文档（PDF 776-778 行）：签名可能在空文本 part 上返回
    // trailingSignature 是来自空 text part 的签名，必须用独立的空 thinking 块承载
    // 不能附加到之前的 thinking 块（签名必须在收到它的 part 位置返回）
    // 注意：Claude Code 在未启用 thinking 时可能不接受 thinking 块。
    // 当本次响应里没有出现任何 thinking（part.thought=true）时，丢弃 trailingSignature，
    // 以保持响应结构与官方一致（纯 text/tool_use）。
    if (this.trailingSignature && this.hasThinking) {
      this.emit("content_block_start", {
        type: "content_block_start",
        index: this.blockIndex,
        content_block: { type: "thinking", thinking: "", signature: "" }
      });
      this.emitDelta("thinking_delta", { thinking: "" });
      this.emitDelta("signature_delta", { signature: this.trailingSignature });
      this.emit("content_block_stop", {
        type: "content_block_stop",
        index: this.blockIndex
      });
      this.blockIndex++;
      this.trailingSignature = null;
    } else if (this.trailingSignature) {
      this.trailingSignature = null;
    }
    
    // 确定 stop_reason
    let stopReason = "end_turn";
    if (this.usedTool) {
      stopReason = "tool_use";
    } else if (finishReason === "MAX_TOKENS") {
      stopReason = "max_tokens";
    }
    
    const usage = toClaudeUsage(usageMetadata || {});
    const mergedUsage =
      extraUsage && typeof extraUsage === "object"
        ? { ...usage, ...extraUsage }
        : usage;
    
    this.emit("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: mergedUsage
    });
    
    if (!this.messageStopSent) {
      this.controller.enqueue(
        this.encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n')
      );
      this.messageStopSent = true;
    }
  }
}

// ==================== Part 处理器 ====================
class PartProcessor {
  constructor(state) {
    this.state = state;
  }
  
  // 处理单个 part
  process(part) {
    const signature = part.thoughtSignature;
    
    // 函数调用处理
    // 根据官方文档（PDF 44行）：签名必须原样返回到收到签名的那个 part
    // - Gemini 3 Pro：签名在第一个 FC（PDF 784行）
    // - Gemini 2.5：签名在第一个 part，不论类型（PDF 785行）
    // 所以 FC 只使用自己的签名，不消费 thinking 的签名
    if (part.functionCall) {
      // 修复场景 B4/C3：空 text 带签名后跟 FC
      // 必须先输出空 thinking 块承载 trailingSignature，再处理 FC
      if (this.state.trailingSignature) {
        // Claude Code 在未启用 thinking 时可能不接受 thinking 块；当本次响应未出现 thinking 时丢弃签名
        if (this.state.hasThinking) {
          this.state.startBlock(StreamingState.BLOCK_THINKING, { type: "thinking", thinking: "" });
          this.state.emitDelta("thinking_delta", { thinking: "" });
          this.state.emitDelta("signature_delta", { signature: this.state.trailingSignature });
          this.state.endBlock();
        }
        this.state.trailingSignature = null;
      }
      this.processFunctionCall(part.functionCall, signature);
      return;
    }
    
    // 空 text 带签名：暂存到 trailingSignature，不能混入 thinking 的签名
    if (part.text !== undefined && !part.thought && part.text.length === 0) {
      if (signature) {
        this.state.trailingSignature = signature;
      }
      return;
    }
    
    if (part.text !== undefined) {
      if (part.thought) {
        // thinking 场景
        this.state.hasThinking = true;
        
        // 修复：如果有 trailingSignature（来自之前的空 text），先输出空 thinking 块
        // 根据规范（PDF 44行）：签名必须在收到它的 part 位置返回
        if (this.state.trailingSignature) {
          this.state.startBlock(StreamingState.BLOCK_THINKING, { type: "thinking", thinking: "" });
          this.state.emitDelta("thinking_delta", { thinking: "" });
          this.state.emitDelta("signature_delta", { signature: this.state.trailingSignature });
          this.state.endBlock();
          this.state.trailingSignature = null;
        }
        
        this.processThinking(part.text);
        // 签名暂存，在 thinking 块结束时发送
        if (signature) {
          this.state.signatures.store(signature);
        }
      } else {
        // 非 thinking text 场景
        
        // 修复：如果有 trailingSignature（来自之前的空 text），先输出空 thinking 块
        // 根据规范（PDF 44行）：签名必须在收到它的 part 位置返回
        if (this.state.trailingSignature) {
          // Claude Code 在未启用 thinking 时可能不接受 thinking 块；当本次响应未出现 thinking 时丢弃签名
          if (this.state.hasThinking) {
            this.state.startBlock(StreamingState.BLOCK_THINKING, { type: "thinking", thinking: "" });
            this.state.emitDelta("thinking_delta", { thinking: "" });
            this.state.emitDelta("signature_delta", { signature: this.state.trailingSignature });
            this.state.endBlock();
          }
          this.state.trailingSignature = null;
        }
        
        if (signature) {
          // Claude Code 在未启用 thinking 时可能不接受 thinking 块；
          // 对于「text 上的 thoughtSignature」在无 thinking 的响应中直接忽略，保持官方同款结构。
          if (!this.state.hasThinking) {
            this.processText(part.text);
            return;
          }
          // 根据规范（PDF 行44）：非空 text 带签名必须立即处理，不能合并到当前 text 块
          // 1. 先关闭当前块
          this.state.endBlock();
          // 2. 开始新 text 块并发送内容
          this.state.startBlock(StreamingState.BLOCK_TEXT, { type: "text", text: "" });
          this.state.emitDelta("text_delta", { text: part.text });
          // 3. 关闭 text 块
          this.state.endBlock();
          // 4. 创建空 thinking 块承载签名（Claude 格式限制：text 不支持 signature）
          this.state.emit("content_block_start", {
            type: "content_block_start",
            index: this.state.blockIndex,
            content_block: { type: "thinking", thinking: "", signature: "" }
          });
          this.state.emitDelta("thinking_delta", { thinking: "" });
          this.state.emitDelta("signature_delta", { signature });
          this.state.emit("content_block_stop", {
            type: "content_block_stop",
            index: this.state.blockIndex
          });
          this.state.blockIndex++;
        } else {
          this.processText(part.text);
        }
      }
      return;
    }
  }
  
  // 处理 thinking 内容（签名由调用方在 process() 中处理）
  processThinking(text) {
    if (this.state.blockType === StreamingState.BLOCK_THINKING) {
      // 继续 thinking
      this.state.emitDelta("thinking_delta", { thinking: text });
    } else {
      // 开始新的 thinking 块
      this.state.startBlock(StreamingState.BLOCK_THINKING, { type: "thinking", thinking: "" });
      this.state.emitDelta("thinking_delta", { thinking: text });
    }
  }
  
  // 处理普通文本
  processText(text) {
    if (!text) return;
    
    if (this.state.blockType === StreamingState.BLOCK_TEXT) {
      // 继续 text
      this.state.emitDelta("text_delta", { text });
    } else {
      // 开始新的 text 块
      this.state.startBlock(StreamingState.BLOCK_TEXT, { type: "text", text: "" });
      this.state.emitDelta("text_delta", { text });
    }
  }
  
  // 处理函数调用
  processFunctionCall(fc, sigToUse) {
    // 签名已在 process() 中处理：FC 自带签名优先，否则使用 thinking 暂存的签名
    const toolId = typeof fc.id === "string" && fc.id ? fc.id : makeToolUseId();
    
    const toolUseBlock = {
      type: "tool_use",
      id: toolId,
      name: fc.name,
      input: {}
    };
    
    // 根据官方文档：签名附加到 tool_use 块
    if (sigToUse) {
      toolUseBlock.signature = sigToUse;
      rememberToolThoughtSignature(toolId, sigToUse);
    }
    
    this.state.startBlock(StreamingState.BLOCK_FUNCTION, toolUseBlock);
    
    if (fc.args) {
      this.state.emitDelta("input_json_delta", { partial_json: JSON.stringify(fc.args) });
    }
    
    this.state.usedTool = true;
  }
}

// ==================== 非流式处理器 ====================
class NonStreamingProcessor {
  constructor(rawJSON) {
    this.raw = rawJSON;
    this.contentBlocks = [];
    this.textBuilder = "";
    this.thinkingBuilder = "";
    this.hasToolCall = false;
    this.hasThinking = false;
    // 分离两种签名来源：
    // thinkingSignature: 来自 thought=true 的 part，随 thinking 块输出
    // trailingSignature: 来自空普通文本的 part，在 process() 末尾用空 thinking 块承载
    this.thinkingSignature = null;
    this.trailingSignature = null;
  }
  
  process() {
    const parts = this.raw.candidates?.[0]?.content?.parts || [];

    // 非流式可一次性预扫，确保“本次响应是否启用 thinking”判断不会被顺序影响
    this.hasThinking = parts.some((p) => p?.thought);
    
    for (const part of parts) {
      this.processPart(part);
    }
    
    // 刷新剩余内容（按原始顺序）
    this.flushThinking();
    this.flushText();
    
    // 处理空普通文本带签名的场景（PDF 776-778）
    // 签名在最后一个 part，但那是空文本，需要输出空 thinking 块承载签名
    // 注意：当本次响应完全没有 thinking（part.thought=true）时，丢弃 trailingSignature，
    // 避免在非 thinking 模式下返回额外的 thinking 块（Claude Code 兼容性）。
    if (this.trailingSignature && this.hasThinking) {
      this.contentBlocks.push({
        type: "thinking",
        thinking: "",
        signature: this.trailingSignature
      });
      this.trailingSignature = null;
    } else if (this.trailingSignature) {
      this.trailingSignature = null;
    }
    
    return this.buildResponse();
  }
  
  processPart(part) {
    const signature = part.thoughtSignature;
    
    // FC 处理：先刷新之前的内容，再处理 FC（防止 FC 签名污染 thinking 块）
    if (part.functionCall) {
      // 根据官方文档（PDF 44行）：签名必须原样返回到收到签名的那个 part
      // thinking 的签名留在 thinking 块，FC 的签名留在 FC 块
      this.flushThinking();
      this.flushText();
      
      // 修复场景 B4/C3：空 text 带签名后跟 FC（Gemini 2.5 风格）
      // 必须先输出空 thinking 块承载 trailingSignature，再处理 FC
      if (this.trailingSignature) {
        // Claude Code 在未启用 thinking 时可能不接受 thinking 块；当本次响应未出现 thinking 时丢弃签名
        if (this.hasThinking) {
          this.contentBlocks.push({
            type: "thinking",
            thinking: "",
            signature: this.trailingSignature,
          });
        }
        this.trailingSignature = null;
      }
      
      this.hasToolCall = true;
      
      // 优先复用上游的 functionCall.id
      const toolId =
        typeof part.functionCall.id === "string" && part.functionCall.id ? part.functionCall.id : makeToolUseId();
      
      const toolUseBlock = {
        type: "tool_use",
        id: toolId,
        name: part.functionCall.name,
        input: part.functionCall.args || {}
      };
      
      // 只使用 FC 自己的签名
      if (signature) {
        toolUseBlock.signature = signature;
        rememberToolThoughtSignature(toolId, signature);
      }
      
      this.contentBlocks.push(toolUseBlock);
      return;
    }
    
    // 使用 !== undefined 判断，确保空字符串 thinking 也能正确处理签名
    if (part.text !== undefined) {
      if (part.thought) {
        this.flushText();
        
        // 修复：如果有 trailingSignature（来自之前的空 text），先输出空 thinking 块
        // 根据规范（PDF 44行）：签名必须在收到它的 part 位置返回
        if (this.trailingSignature) {
          this.flushThinking();  // 先刷新之前累积的 thinking
          if (this.hasThinking) {
            this.contentBlocks.push({
              type: "thinking",
              thinking: "",
              signature: this.trailingSignature,
            });
          }
          this.trailingSignature = null;
        }
        
        this.thinkingBuilder += part.text;
        // thinking 的签名暂存到 thinkingSignature，在 flushThinking 时消费
        if (signature) {
          this.thinkingSignature = signature;
        }
      } else {
        // 根据官方规范（PDF 行44）：签名必须在收到它的 part 位置返回
        // 非空 text 带签名时，先刷新当前 text，再输出空 thinking 块承载签名
        // 空 text 带签名时，暂存到 trailingSignature，在 process() 末尾消费
        if (part.text.length === 0) {
          // 空普通文本的签名暂存
          if (signature) {
            this.trailingSignature = signature;
          }
          return;
        }
        
        this.flushThinking();
        
        // 修复：如果有 trailingSignature（来自之前的空 text），先输出空 thinking 块
        // 根据规范（PDF 44行）：签名必须在收到它的 part 位置返回
        if (this.trailingSignature) {
          this.flushText();  // 先刷新之前累积的 text
          // Claude Code 在未启用 thinking 时可能不接受 thinking 块；当本次响应未出现 thinking 时丢弃签名
          if (this.hasThinking) {
            this.contentBlocks.push({
              type: "thinking",
              thinking: "",
              signature: this.trailingSignature,
            });
          }
          this.trailingSignature = null;
        }
        
        this.textBuilder += part.text;
        
        // 非空 text 带签名：仅在本次响应里出现过 thinking 时才输出空 thinking 块承载签名；
        // 否则丢弃该签名，保持响应结构与官方一致（纯 text/tool_use）。
        if (signature && this.hasThinking) {
          this.flushText();
          this.contentBlocks.push({
            type: "thinking",
            thinking: "",
            signature: signature
          });
        }
      }
    }
  }
  
  flushText() {
    if (this.textBuilder.length === 0) return;
    this.contentBlocks.push({
      type: "text",
      text: this.textBuilder
    });
    this.textBuilder = "";
  }
  
  flushThinking() {
    // 如果没有 thinking 内容且没有 thinking 签名，直接返回
    // 有 thinkingSignature 时必须输出（即使 thinking 为空），保证签名在正确位置
    if (this.thinkingBuilder.length === 0 && !this.thinkingSignature) return;
    
    const block = {
      type: "thinking",
      thinking: this.thinkingBuilder || ""
    };
    
    // 如果有 thinking 签名，附加到 thinking 块
    if (this.thinkingSignature) {
      block.signature = this.thinkingSignature;
      this.thinkingSignature = null;
    }
    
    this.contentBlocks.push(block);
    this.thinkingBuilder = "";
  }
  
  buildResponse() {
    const finish = this.raw.candidates?.[0]?.finishReason;
    let stopReason = "end_turn";
    
    if (this.hasToolCall) {
      stopReason = "tool_use";
    } else if (finish === "MAX_TOKENS") {
      stopReason = "max_tokens";
    }
    
    const response = {
      id: this.raw.responseId || "",
      type: "message",
      role: "assistant",
      model: this.raw.modelVersion || "",
      content: this.contentBlocks,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: toClaudeUsage(this.raw.usageMetadata)
    };
    
    // 如果没有 usage 数据，删除该字段
    if (response.usage.input_tokens === 0 && response.usage.output_tokens === 0) {
      if (!this.raw.usageMetadata) {
        delete response.usage;
      }
    }
    
    return response;
  }
}

// ==================== 工具函数 ====================

// 提取 thoughtSignature
function extractThoughtSignature(parts = []) {
  const match = (parts || []).find((part) => part?.thoughtSignature);
  return match?.thoughtSignature ?? undefined;
}

// 转换 usageMetadata 为 Claude 格式
function toClaudeUsage(usageMetadata = {}) {
  const prompt = usageMetadata.promptTokenCount || 0;
  const candidates = usageMetadata.candidatesTokenCount || 0;
  const thoughts = usageMetadata.thoughtsTokenCount || 0;
  
  if (usageMetadata.totalTokenCount && usageMetadata.totalTokenCount >= prompt) {
    return {
      input_tokens: prompt,
      output_tokens: usageMetadata.totalTokenCount - prompt
    };
  }
  
  return {
    input_tokens: prompt,
    output_tokens: candidates + thoughts
  };
}

// ==================== 请求转换相关 ====================

/**
 * 清理 JSON Schema 以符合 Gemini 格式
 */
function cleanJsonSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(cleanJsonSchema);

  const validationFields = {
    minLength: "minLength",
    maxLength: "maxLength",
    minimum: "minimum",
    maximum: "maximum",
    exclusiveMinimum: "exclusiveMinimum",
    exclusiveMaximum: "exclusiveMaximum",
    minItems: "minItems",
    maxItems: "maxItems",
  };
  const removeKeys = new Set([
    "$schema",
    "additionalProperties",
    "format",
    "default",
    "uniqueItems",
    // v1internal Schema doesn't support JSON Schema draft keywords like `propertyNames`.
    "propertyNames",
  ]);
  let constValue;

  const validations = [];
  for (const [field, label] of Object.entries(validationFields)) {
    if (field in schema) {
      validations.push(`${label}: ${schema[field]}`);
    }
  }

  const cleaned = {};
  for (const [key, value] of Object.entries(schema)) {
    // Gemini Schema doesn't support JSON Schema "const"; map to enum([value]).
    if (key === "const") {
      constValue = value;
      continue;
    }

    if (removeKeys.has(key) || key in validationFields) continue;

    // Normalize union types like ["string","null"] to a single type (prefer non-null)
    if (key === "type" && Array.isArray(value)) {
      const filtered = value.filter(v => v !== "null");
      cleaned.type = filtered[0] || value[0] || "string";
      continue;
    }

    if (key === "description" && validations.length > 0) {
      cleaned[key] = `${value} (${validations.join(", ")})`;
    } else if (typeof value === "object" && value !== null) {
      cleaned[key] = cleanJsonSchema(value);
    } else {
      cleaned[key] = value;
    }
  }

  if (constValue !== undefined) {
    cleaned.enum = [constValue];
  }

  if (validations.length > 0 && !cleaned.description) {
    cleaned.description = `Validation: ${validations.join(", ")}`;
  }

  return uppercaseSchemaTypes(cleaned);
}

/**
 * 将 schema 类型转换为大写
 */
function uppercaseSchemaTypes(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(uppercaseSchemaTypes);

  const normalized = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "type") {
      if (typeof value === "string") {
        normalized[key] = value.toUpperCase();
      } else if (Array.isArray(value)) {
        normalized[key] = value.map((item) =>
          typeof item === "string" ? item.toUpperCase() : item
        );
      } else {
        normalized[key] = value;
      }
      continue;
    }
    normalized[key] =
      typeof value === "object" && value !== null
        ? uppercaseSchemaTypes(value)
        : value;
  }
  return normalized;
}

/**
 * Claude 模型名映射到 Gemini 模型名
 */
function mapClaudeModelToGemini(claudeModel) {
  const supportedModels = [
    "claude-opus-4-5-thinking",
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-thinking",
  ];
  if (supportedModels.includes(claudeModel)) return claudeModel;

  const mapping = {
    "claude-sonnet-4-5-20250929": "claude-sonnet-4-5-thinking",
    "claude-3-5-sonnet-20241022": "claude-sonnet-4-5",
    "claude-3-5-sonnet-20240620": "claude-sonnet-4-5",
    "claude-opus-4": "claude-opus-4-5-thinking",
    "claude-opus-4-5-20251101": "claude-opus-4-5-thinking",
    "claude-opus-4-5": "claude-opus-4-5-thinking",
    "claude-haiku-4": "claude-sonnet-4-5",
    "claude-3-haiku-20240307": "claude-sonnet-4-5",
    "claude-haiku-4-5-20251001": "claude-sonnet-4-5",
    "gemini-2.5-flash": "gemini-2.5-flash",
    "gemini-3-flash": "gemini-3-flash"
  };
  return mapping[claudeModel] || "claude-sonnet-4-5";
}

/**
 * 转换 Claude 请求为 v1internal 请求 body（不包含 URL/Authorization）。
 * @param {Object} claudeReq - Claude 格式的请求
 * @param {string} projectId - 项目 ID
 * @param {Object} [options]
 * @param {boolean} [options.forwardThoughtSignatures=true] - 是否转发 thoughtSignature / thought=true
 * @param {number} [options.signatureSegmentStartIndex] - 只转发 messages[>=start] 内的签名（用于跨模型段隔离）
 * @returns {{ body: object }} 包含 v1internal body 的对象
 */
function transformClaudeRequestIn(claudeReq, projectId, options = {}) {
  // 需要 crypto 模块生成 requestId
  const crypto = require("crypto");
  
	  const hasWebSearchTool =
	    Array.isArray(claudeReq.tools) &&
	    claudeReq.tools.some((tool) => tool?.name === "web_search");

	  const isClaudeModel = String(mapClaudeModelToGemini(claudeReq.model)).startsWith("claude");

  // thoughtSignature（Thought Signatures 协议）：
  // - 同模型链路（Claude↔Claude / Gemini↔Gemini）必须原样转发，否则会出现签名缺失/不匹配导致 400。
  // - 跨模型切换时应在路由层按“段”清洗（避免把上一段模型签名带到另一段上游）。
  const forwardThoughtSignaturesByDefault = options?.forwardThoughtSignatures !== false;
  const signatureSegmentStartIndex = Number.isInteger(options?.signatureSegmentStartIndex)
    ? options.signatureSegmentStartIndex
    : null;

  // 记录 tool_use id 到 name 的映射，便于后续 tool_result 还原函数名
  const toolIdToName = new Map();

  // 1. System Instruction
  let systemInstruction = undefined;
	  if (claudeReq.system) {
	    const systemParts = [];
	    let injectedMcpHintIntoSystem = false;
	    if (Array.isArray(claudeReq.system)) {
	      for (const item of claudeReq.system) {
	        if (item && item.type === "text") {
	          let text = item.text || "";
	          const injectedResult = maybeInjectMcpHintIntoSystemText({
	            text,
	            claudeReq,
	            isClaudeModel,
	            injected: injectedMcpHintIntoSystem,
	          });
	          text = injectedResult.text;
	          injectedMcpHintIntoSystem = injectedResult.injected;
	          systemParts.push({ text });
	        }
	      }
	    } else if (typeof claudeReq.system === "string") {
	      systemParts.push({ text: claudeReq.system });
    }

    if (systemParts.length > 0) {
      systemInstruction = {
        role: "user",
        parts: systemParts,
      };
    }
  }

  // 2. Contents (Messages)
  const contents = [];
  // Claude Code / 部分客户端会在每次 tool_result 后重复附带同一句“任务指令”文本。
  // 这通常只是上下文回显，并非新指令；为避免上游模型每轮都被重复文本误导，这里做一次轻量去重：
  // - 仅在「tool_result 后紧跟的 text」与上一轮用户任务文本完全一致（忽略空白）时跳过该 text。
  let lastUserTaskTextNormalized = null;
  if (claudeReq.messages) {
    for (let msgIndex = 0; msgIndex < claudeReq.messages.length; msgIndex++) {
      const msg = claudeReq.messages[msgIndex];
      const shouldForwardThoughtSignatures =
        forwardThoughtSignaturesByDefault &&
        (signatureSegmentStartIndex == null || msgIndex >= signatureSegmentStartIndex);
      let role = msg.role;
      if (role === "assistant") {
        role = "model";
      }

      const clientContent = { role, parts: [] };
      // Claude extended-thinking blocks must be leading within an assistant message. If we ever see a
      // thinking block after any non-thinking content (text/tool/image/etc), drop it to avoid invalid
      // thought parts (and leaking late "thinking" as plain text).
      let sawNonThinkingContent = false;
      let previousWasToolResult = false;
      
      if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item.type === "text") {
            const text = typeof item.text === "string" ? item.text : "";
            if (!text || text === "(no content)") continue;
            if (
              role === "user" &&
              previousWasToolResult &&
              lastUserTaskTextNormalized &&
              text.replace(/\s+/g, "") === lastUserTaskTextNormalized
            ) {
              // Skip duplicated task text echoed after tool_result.
              previousWasToolResult = false;
              continue;
            }
            clientContent.parts.push({ text });
            sawNonThinkingContent = true;
            previousWasToolResult = false;
            if (role === "user") lastUserTaskTextNormalized = text.replace(/\s+/g, "");
          } else if (item.type === "thinking") {
            // 根据官方文档：签名必须在收到签名的那个 part 上原样返回
            // 重要：我们在 response 侧会用一个空的 Claude "thinking" block 来承载“空 text part 的 thoughtSignature”（Claude text 不支持 signature）。
            // 这个 block 本质上是“空 text + signature”，不应当在 v1internal 中还原成 thought=true（否则会上游被当作 thinking block 校验，可能触发 400）。
            const thinkingText = typeof item.thinking === "string" ? item.thinking : "";
            const signature = typeof item.signature === "string" ? item.signature : "";

            if (signature && thinkingText.length === 0) {
              // 文本签名载体块：严格按官方参考行为合并回“前一个非空 text part”（绝不附着到 functionCall）。
              if (!shouldForwardThoughtSignatures) continue;
              for (let i = clientContent.parts.length - 1; i >= 0; i--) {
                const p = clientContent.parts[i];
                const canCarry =
                  p &&
                  p.thought !== true &&
                  !p.thoughtSignature &&
                  typeof p.text === "string" &&
                  p.text.length > 0;
                if (!canCarry) continue;
                p.thoughtSignature = signature;
                break;
              }
              continue;
            }

            // 避免请求侧发送空字符串字段（部分上游会直接 400）
            if (thinkingText.length === 0) continue;

            // thinking blocks must be leading within the assistant message.
            if (sawNonThinkingContent) continue;

            // Claude 上游在开启 thinking 时会校验签名；如果历史里出现 thinking 但没有 signature，
            // 继续以 thought=true 回传会直接 400（messages.*.thinking.signature: Field required）。
            // 这种情况下只能降级为普通 text part，避免破坏整体链路（不影响已有的签名转发逻辑）。
            if (signature && shouldForwardThoughtSignatures) {
              clientContent.parts.push({ text: thinkingText, thought: true, thoughtSignature: signature });
            } else {
              clientContent.parts.push({ text: thinkingText });
              sawNonThinkingContent = true;
            }
            previousWasToolResult = false;
          } else if (item.type === "redacted_thinking") {
            const text = typeof item.data === "string" ? item.data : "";
            if (!text) continue;
            if (sawNonThinkingContent) continue;
            // redacted_thinking 同样可能没有签名，按普通文本降级，避免上游签名校验报错
            clientContent.parts.push({ text });
            sawNonThinkingContent = true;
            previousWasToolResult = false;
          } else if (item.type === "image") {
            // Handle image
            const source = item.source || {};
            if (source.type === "base64") {
              clientContent.parts.push({
                inlineData: {
                  mimeType: source.media_type || "image/png",
                  data: source.data || "",
                },
              });
              sawNonThinkingContent = true;
            }
            previousWasToolResult = false;
          } else if (item.type === "tool_use") {
            // 根据官方文档：签名必须在收到签名的那个 functionCall part 上原样返回
            const fcPart = {
              functionCall: {
                name: item.name,
                args: item.input || {},
                id: item.id,
              },
            };
            if (item.id && item.name) {
              toolIdToName.set(item.id, item.name);
            }
            // 如果 tool_use 有 signature（少数客户端会回传），直接使用；
            // 否则从缓存补回（Claude Code 不会回传 tool_use.signature）。
            const sig = item.signature || getToolThoughtSignature(item.id);
            if (sig && shouldForwardThoughtSignatures) {
              fcPart.thoughtSignature = sig;
              if (!item.signature && isDebugEnabled()) {
                console.log(`[ThoughtSignature] injected tool_use.id=${item.id}`);
              }
            }
            clientContent.parts.push(fcPart);
            sawNonThinkingContent = true;
            previousWasToolResult = false;
          } else if (item.type === "tool_result") {
            // 优先用先前记录的 tool_use id -> name 映射，还原原始函数名
            let funcName = toolIdToName.get(item.tool_use_id) || item.tool_use_id;
            
            let content = item.content || "";
            if (Array.isArray(content)) {
              content = content.map(c => c.text || JSON.stringify(c)).join("\n");
            }

            clientContent.parts.push({
              functionResponse: {
                name: funcName,
                response: { result: content },
                id: item.tool_use_id,
              },
            });
            sawNonThinkingContent = true;
            previousWasToolResult = true;
          }
        }
      } else if (typeof msg.content === "string") {
        const text = msg.content;
        if (text) {
          clientContent.parts.push({ text });
          if (role === "user") lastUserTaskTextNormalized = String(text).replace(/\s+/g, "");
        }
      }
      
      if (clientContent.parts.length > 0) {
        contents.push(clientContent);
      }
    }
  }

  // 3. Tools
  let tools = undefined;
  if (claudeReq.tools && Array.isArray(claudeReq.tools)) {
    if (hasWebSearchTool) {
      // 映射 web_search 到 googleSearch 工具，带增强配置
      tools = [
        {
          googleSearch: {
            enhancedContent: {
              imageSearch: {
                maxResultCount: 5,
              },
            },
          },
        },
      ];
    } else {
      tools = [{ functionDeclarations: [] }];

      for (const tool of claudeReq.tools) {
        // Claude 模型下：不把 mcp__ 工具暴露给上游（避免上游尝试 tool_use）
        if (
          isClaudeModel &&
          typeof tool?.name === "string" &&
          tool.name.startsWith("mcp__")
        ) {
          continue;
        }
        if (tool.input_schema) {
          const toolDecl = {
            name: tool.name,
            description: tool.description,
            parameters: cleanJsonSchema(tool.input_schema),
          };
          tools[0].functionDeclarations.push(toolDecl);
        }
      }
    }
  }

  // 4. Generation Config & Thinking
  const generationConfig = {};
  
  // Thinking - 只要启用 thinking 就必须设置 includeThoughts: true
  if (claudeReq.thinking && claudeReq.thinking.type === "enabled") {
    generationConfig.thinkingConfig = {
      includeThoughts: true
    };
    // 如果提供了 budget_tokens，则设置 thinkingBudget
    if (claudeReq.thinking.budget_tokens) {
      let budget = claudeReq.thinking.budget_tokens;
      // 使用 gemini-2.5-flash 时官方上限 24576，其余模型不强制改动
      const isFlashModel =
        hasWebSearchTool || (claudeReq.model && claudeReq.model.includes("gemini-2.5-flash"));
      if (isFlashModel) {
        budget = Math.min(budget, 24576);
      }
      generationConfig.thinkingConfig.thinkingBudget = budget;
    }
  }

  if (claudeReq.temperature !== undefined) {
    generationConfig.temperature = claudeReq.temperature;
  }
  if (claudeReq.top_p !== undefined) {
    generationConfig.topP = claudeReq.top_p;
  }
  if (claudeReq.top_k !== undefined) {
    generationConfig.topK = claudeReq.top_k;
  }

  // web_search 场景强制 candidateCount=1
  if (hasWebSearchTool) {
    generationConfig.candidateCount = 1;
  }

  // max_tokens 映射到 maxOutputTokens，且不超过 64000
  // if (claudeReq.max_tokens !== undefined) {
  //   generationConfig.maxOutputTokens = Math.min(claudeReq.max_tokens, 64000);
  // }
  generationConfig.maxOutputTokens = 64000;
  // Safety Settings
  const safetySettings = [
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
    { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "OFF" },
  ];

  // Build Request Body
  const innerRequest = {
    contents,
    tools:
      tools &&
      tools.length > 0 &&
      tools[0].functionDeclarations &&
      tools[0].functionDeclarations.length > 0
        ? tools
        : tools && tools.length > 0 && tools[0].googleSearch
        ? tools
        : undefined,
  };
  
  if (systemInstruction) {
    innerRequest.systemInstruction = systemInstruction;
  }
  
  // Add generationConfig if not empty
  if (Object.keys(generationConfig).length > 0) {
    innerRequest.generationConfig = generationConfig;
  }
  
  innerRequest.safetySettings = safetySettings;

  let geminiModel = mapClaudeModelToGemini(claudeReq.model);
  if (hasWebSearchTool) {
    geminiModel = "gemini-2.5-flash";
  }
  const requestId = `agent-${crypto.randomUUID()}`;
  const requestType = hasWebSearchTool ? "web_search" : "agent";

  const body = {
    project: projectId,
    requestId: requestId,
    request: innerRequest,
    model: geminiModel,
    userAgent: "antigravity",
    requestType,
  };

  // 如果调用方提供了 metadata.user_id，则复用为 sessionId
  if (claudeReq.metadata && claudeReq.metadata.user_id) {
    body.request.sessionId = claudeReq.metadata.user_id;
  }

  return {
    body: body,
  };
}

// ==================== 响应转换相关 ====================

/**
 * 转换 Claude 格式响应
 */
async function transformClaudeResponseOut(response, options = {}) {
  const contentType = response.headers.get("Content-Type") || "";
  
  if (contentType.includes("application/json")) {
    return handleNonStreamingResponse(response, options);
  }
  
  if (contentType.includes("stream")) {
    return handleStreamingResponse(response, options);
  }
  
  return response;
}

// 处理非流式响应
async function handleNonStreamingResponse(response, options = {}) {
  let json = await response.json();
  json = json.response || json;
  
  // v1internal grounding(web search) -> Claude 的 server_tool_use/web_search_tool_result 结构
  const candidate = json?.candidates?.[0] || null;
  const groundingMetadata = candidate?.groundingMetadata || null;
  const hasWebSearchQueries =
    Array.isArray(groundingMetadata?.webSearchQueries) && typeof groundingMetadata.webSearchQueries[0] === "string";
  const hasGroundingChunks =
    Array.isArray(candidate?.groundingChunks) || Array.isArray(groundingMetadata?.groundingChunks);
  const hasGroundingSupports =
    Array.isArray(candidate?.groundingSupports) || Array.isArray(groundingMetadata?.groundingSupports);
  const isWebSearch = hasWebSearchQueries || hasGroundingChunks || hasGroundingSupports;

  if (isWebSearch) {
    const message = await buildNonStreamingWebSearchMessage(json, options);
    if (options?.overrideModel) message.model = options.overrideModel;
    return new Response(JSON.stringify(message), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const processor = new NonStreamingProcessor(json);
  const result = processor.process();
  if (options?.overrideModel) result.model = options.overrideModel;
  
  return new Response(JSON.stringify(result), {
    status: response.status,
    headers: { "Content-Type": "application/json" }
  });
}

async function buildNonStreamingWebSearchMessage(rawJSON, options = {}) {
  const candidate = rawJSON?.candidates?.[0] || {};
  const parts = candidate?.content?.parts || [];
  const groundingMetadata = candidate?.groundingMetadata || {};

  const query =
    Array.isArray(groundingMetadata.webSearchQueries) && typeof groundingMetadata.webSearchQueries[0] === "string"
      ? groundingMetadata.webSearchQueries[0]
      : "";

  const groundingChunks = Array.isArray(candidate.groundingChunks)
    ? candidate.groundingChunks
    : groundingMetadata.groundingChunks;
  const results = toWebSearchResults(Array.isArray(groundingChunks) ? groundingChunks : []);

  const groundingSupports = Array.isArray(candidate.groundingSupports)
    ? candidate.groundingSupports
    : groundingMetadata.groundingSupports;
  const supports = Array.isArray(groundingSupports) ? groundingSupports : [];

  // 同 streaming：尽力把 vertex redirect 解析成真实落地 URL
  await resolveWebSearchRedirectUrls({ results });

  const thinkingText = parts
    .filter((p) => p?.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("");

  const answerText = parts
    .filter((p) => !p?.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("");

  const toolUseId = makeSrvToolUseId();

  const content = [];
  if (thinkingText) content.push({ type: "thinking", thinking: thinkingText });

  content.push({
    type: "server_tool_use",
    id: toolUseId,
    name: "web_search",
    input: { query },
  });

  content.push({
    type: "web_search_tool_result",
    tool_use_id: toolUseId,
    content: results,
  });

  // citations-only blocks（简化版：每个 support 取第一个 groundingChunkIndex）
  for (const support of supports) {
    const citation = buildCitationFromSupport(results, support);
    if (!citation) continue;
    content.push({ type: "text", text: "", citations: [citation] });
  }

  if (answerText) content.push({ type: "text", text: answerText });

  const finish = candidate?.finishReason;
  const stopReason = finish === "MAX_TOKENS" ? "max_tokens" : "end_turn";
  const usage = toClaudeUsage(rawJSON.usageMetadata || {});

  return {
    id: rawJSON.responseId || "",
    type: "message",
    role: "assistant",
    model: options?.overrideModel || rawJSON.modelVersion || "",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { ...usage, server_tool_use: { web_search_requests: 1 } },
  };
}

// 处理流式响应
async function handleStreamingResponse(response, options = {}) {
  if (!response.body) return response;
  
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  
  const stream = new ReadableStream({
    async start(controller) {
      const state = new StreamingState(encoder, controller);
      if (options?.overrideModel) state.overrideModel = options.overrideModel;
      const processor = new PartProcessor(state);
      
      try {
        let buffer = "";
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          
          for (const line of lines) {
            await processSSELine(line, state, processor);
          }
        }
        
        // 处理剩余 buffer
        if (buffer) {
          await processSSELine(buffer, state, processor);
        }
        
      } catch (error) {
        controller.error(error);
      } finally {
        controller.close();
      }
    }
  });
  
  return new Response(stream, {
    status: response.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    }
  });
}

// 处理单行 SSE 数据
async function processSSELine(line, state, processor) {
  if (!line.startsWith("data: ")) return;
  
  const dataStr = line.slice(6).trim();
  if (!dataStr) return;
  
  if (dataStr === "[DONE]") {
    if (!state.messageStopSent) {
      state.controller.enqueue(
        state.encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n')
      );
      state.messageStopSent = true;
    }
    return;
  }
  
  try {
    let chunk = JSON.parse(dataStr);
    const rawJSON = chunk.response || chunk;

    const candidate = rawJSON.candidates?.[0] || null;
    const hasGrounding =
      candidate &&
      (Object.prototype.hasOwnProperty.call(candidate, "groundingMetadata") ||
        Object.prototype.hasOwnProperty.call(candidate, "groundingChunks") ||
        Object.prototype.hasOwnProperty.call(candidate, "groundingSupports"));
    
    // 发送 message_start
    state.emitMessageStart(rawJSON);

    // 进入 web_search 模式（基于 grounding 字段）
    if (!state.webSearchMode && hasGrounding) {
      state.webSearchMode = true;
      state.webSearch.toolUseId = makeSrvToolUseId();
    }
    
    // 处理所有 parts
    const parts = candidate?.content?.parts || [];
    if (!state.webSearchMode) {
      for (const part of parts) processor.process(part);
    } else {
      // web_search 模式：thinking 实时输出；非 thinking 文本缓存到最后一个 text block 再输出
      for (const part of parts) {
        if (part?.text === undefined) continue;
        if (part.thought) {
          processor.process(part);
        } else {
          state.webSearch.bufferedTextParts.push(String(part.text));
        }
      }

      // 更新 grounding 数据（通常在最后一个 chunk 才完整出现）
      const webSearchQueries = candidate?.groundingMetadata?.webSearchQueries;
      if (Array.isArray(webSearchQueries) && typeof webSearchQueries[0] === "string") {
        state.webSearch.query = webSearchQueries[0];
      }
      const groundingChunks = Array.isArray(candidate?.groundingChunks)
        ? candidate.groundingChunks
        : candidate?.groundingMetadata?.groundingChunks;
      if (Array.isArray(groundingChunks)) {
        state.webSearch.results = toWebSearchResults(groundingChunks);
      }
      const groundingSupports = Array.isArray(candidate?.groundingSupports)
        ? candidate.groundingSupports
        : candidate?.groundingMetadata?.groundingSupports;
      if (Array.isArray(groundingSupports)) {
        state.webSearch.supports = groundingSupports;
      }
    }
    
    // 检查是否结束
    const finishReason = candidate?.finishReason;
    if (finishReason) {
      if (!state.webSearchMode) {
        state.emitFinish(finishReason, rawJSON.usageMetadata);
        return;
      }

      // web_search：在 message_delta 前补齐 server_tool_use / tool_result / citations / 最终文本
      await resolveWebSearchRedirectUrls(state.webSearch);
      emitWebSearchBlocks(state);
      state.emitFinish(finishReason, rawJSON.usageMetadata, {
        server_tool_use: { web_search_requests: 1 },
      });
    }
    
  } catch (e) {
    // 解析失败，忽略
  }
}

function makeSrvToolUseId() {
  return `srvtoolu_${Math.random().toString(36).slice(2, 26)}`;
}

function stableEncryptedContent(payload) {
  try {
    const json = JSON.stringify(payload);
    return Buffer.from(json, "utf8").toString("base64");
  } catch {
    return "";
  }
}

function toWebSearchResults(groundingChunks = []) {
  return (groundingChunks || [])
    .map((chunk) => {
      const web = chunk?.web || {};
      const url = typeof web.uri === "string" ? web.uri : "";
      const title = typeof web.title === "string" ? web.title : (typeof web.domain === "string" ? web.domain : "");
      return {
        type: "web_search_result",
        title,
        url,
        encrypted_content: stableEncryptedContent({ url, title }),
        page_age: null,
      };
    })
    .filter((r) => r.url || r.title);
}

const resolvedRedirectUrlCache = new Map(); // vertex redirect url -> final url

function isVertexGroundingRedirectUrl(url) {
  return (
    typeof url === "string" &&
    url.startsWith("https://vertexaisearch.cloud.google.com/grounding-api-redirect/")
  );
}

async function fetchFinalUrl(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
    // node-fetch/undici: final URL is exposed as res.url
    if (res && typeof res.url === "string" && res.url) return res.url;
    return url;
  } catch (e) {
    // Some hosts don't support HEAD; fallback to GET
    try {
      const res = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal });
      const finalUrl = res && typeof res.url === "string" && res.url ? res.url : url;
      try {
        if (res?.body?.cancel) await res.body.cancel();
      } catch {}
      try {
        if (res?.body?.destroy) res.body.destroy();
      } catch {}
      return finalUrl;
    } catch {
      return url;
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

async function resolveVertexGroundingRedirectUrl(url) {
  if (!isVertexGroundingRedirectUrl(url)) return url;
  const cached = resolvedRedirectUrlCache.get(url);
  if (typeof cached === "string") return cached;
  if (cached && typeof cached.then === "function") return cached;

  const promise = (async () => {
    const finalUrl = await fetchFinalUrl(url, 1500);
    return finalUrl;
  })();

  resolvedRedirectUrlCache.set(url, promise);
  try {
    const finalUrl = await promise;
    resolvedRedirectUrlCache.set(url, finalUrl);
    if (resolvedRedirectUrlCache.size > 2000) resolvedRedirectUrlCache.clear();
    return finalUrl;
  } catch {
    resolvedRedirectUrlCache.delete(url);
    return url;
  }
}

async function resolveWebSearchRedirectUrls(webSearch) {
  const results = Array.isArray(webSearch?.results) ? webSearch.results : [];
  if (results.length === 0) return;

  // Best-effort resolve (proxy-aware: global fetch is already patched in src/utils/proxy.js)
  await Promise.all(
    results.slice(0, 10).map(async (result) => {
      if (!result || typeof result.url !== "string" || !result.url) return;
      const finalUrl = await resolveVertexGroundingRedirectUrl(result.url);
      if (finalUrl && finalUrl !== result.url) {
        result.url = finalUrl;
        result.encrypted_content = stableEncryptedContent({ url: result.url, title: result.title });
      }
    })
  );
}

function buildCitationFromSupport(results, support) {
  const cited_text = support?.segment?.text;
  if (typeof cited_text !== "string" || cited_text.length === 0) return null;

  const idx = Array.isArray(support?.groundingChunkIndices) ? support.groundingChunkIndices[0] : null;
  if (typeof idx !== "number") return null;

  const result = results[idx];
  if (!result) return null;

  return {
    type: "web_search_result_location",
    cited_text,
    url: result.url,
    title: result.title,
    encrypted_index: stableEncryptedContent({ url: result.url, title: result.title, cited_text }),
  };
}

function emitWebSearchBlocks(state) {
  // 确保 index:0 是 thinking（即使为空）
  if (state.blockIndex === 0 && state.blockType === StreamingState.BLOCK_NONE) {
    state.startBlock(StreamingState.BLOCK_THINKING, { type: "thinking", thinking: "" });
    state.emitDelta("thinking_delta", { thinking: "" });
    state.endBlock();
  } else if (state.blockType === StreamingState.BLOCK_THINKING) {
    // 结束 thinking 前补一个空 delta（更贴近官方流式形态）
    state.emitDelta("thinking_delta", { thinking: "" });
    state.endBlock();
  } else {
    state.endBlock();
  }

  const toolUseId = state.webSearch.toolUseId || makeSrvToolUseId();
  state.webSearch.toolUseId = toolUseId;

  // index:1 server_tool_use
  state.startBlock(StreamingState.BLOCK_TEXT, {
    type: "server_tool_use",
    id: toolUseId,
    name: "web_search",
    input: {},
  });
  const query = typeof state.webSearch.query === "string" ? state.webSearch.query : "";
  state.emitDelta("input_json_delta", { partial_json: JSON.stringify({ query }) });
  state.endBlock();

  // index:2 web_search_tool_result
  state.startBlock(StreamingState.BLOCK_TEXT, {
    type: "web_search_tool_result",
    tool_use_id: toolUseId,
    content: Array.isArray(state.webSearch.results) ? state.webSearch.results : [],
  });
  state.endBlock();

  // index:3.. citations-only blocks
  const results = Array.isArray(state.webSearch.results) ? state.webSearch.results : [];
  const supports = Array.isArray(state.webSearch.supports) ? state.webSearch.supports : [];
  for (const support of supports) {
    const citation = buildCitationFromSupport(results, support);
    if (!citation) continue;
    state.startBlock(StreamingState.BLOCK_TEXT, { citations: [], type: "text", text: "" });
    state.emitDelta("citations_delta", { citation });
    state.endBlock();
  }

  // final index：输出非思考 text（原始 chunk 一行一行）
  state.startBlock(StreamingState.BLOCK_TEXT, { type: "text", text: "" });
  for (const text of state.webSearch.bufferedTextParts) {
    if (!text) continue;
    state.emitDelta("text_delta", { text });
  }
  state.endBlock();
}

// ==================== 导出 ====================
module.exports = {
  SignatureManager,
  StreamingState,
  PartProcessor,
  NonStreamingProcessor,
  transformClaudeRequestIn,
  transformClaudeResponseOut,
  extractThoughtSignature,
  toClaudeUsage,
  cleanJsonSchema,
  uppercaseSchemaTypes,
  mapClaudeModelToGemini
};
