const crypto = require("crypto");

// Convert parametersJsonSchema -> parameters (clean + uppercase type names) for v1internal
function cleanSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(cleanSchema);

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
  const result = {};

  for (const [k, v] of Object.entries(schema)) {
    // Gemini Schema doesn't support JSON Schema "const" keyword; map to enum([value]).
    if (k === "const") {
      constValue = v;
      continue;
    }
    if (k in validationFields) {
      validations.push(`${validationFields[k]}: ${v}`);
      continue;
    }
    if (removeKeys.has(k)) continue;

    if (k === "type" && Array.isArray(v)) {
      const filtered = v.filter((x) => x !== "null");
      result.type = filtered[0] || v[0] || "string";
      continue;
    }

    result[k] = typeof v === "object" && v !== null ? cleanSchema(v) : v;
  }

  if (constValue !== undefined) {
    result.enum = [constValue];
  }

  if (validations.length > 0) {
    if (result.description) {
      result.description = `${result.description} (${validations.join(", ")})`;
    } else {
      result.description = `Validation: ${validations.join(", ")}`;
    }
  }

  return result;
}

function uppercaseSchemaTypes(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(uppercaseSchemaTypes);
  const result = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "type") {
      if (typeof v === "string") {
        result[k] = v.toUpperCase();
        continue;
      }
      if (Array.isArray(v)) {
        result[k] = v.map((item) => (typeof item === "string" ? item.toUpperCase() : item));
        continue;
      }
    }
    result[k] = typeof v === "object" && v !== null ? uppercaseSchemaTypes(v) : v;
  }
  return result;
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    if (tool && Array.isArray(tool.functionDeclarations)) {
      tool.functionDeclarations = tool.functionDeclarations.map((fn) => {
        if (fn && typeof fn === "object") {
          if ("parametersJsonSchema" in fn) {
            const { parametersJsonSchema, ...rest } = fn;
            const parameters = uppercaseSchemaTypes(cleanSchema(parametersJsonSchema));
            return parameters ? { ...rest, parameters } : rest;
          }
          if ("parameters" in fn && typeof fn.parameters === "object") {
            return { ...fn, parameters: uppercaseSchemaTypes(cleanSchema(fn.parameters)) };
          }
        }
        return fn;
      });
    }
    return tool;
  });
}

/**
 * Wrap Gemini native request body to v1internal request wrapper.
 * Mirrors current logic in root server.js to preserve behavior.
 *
 * @param {object} clientJson - Parsed JSON body from client.
 * @param {object} options
 * @param {string} options.projectId
 * @param {string} options.modelName
 * @returns {{ wrappedBody: object, mappedModelName: string, requestType: string, hasGoogleSearchTool: boolean }}
 */
function wrapRequest(clientJson, options) {
  const modelName = options.modelName;
  const projectId = options.projectId;

  const innerRequest =
    clientJson && typeof clientJson.request === "object" && clientJson.request
      ? clientJson.request
      : { ...(clientJson || {}) };

  // Force functionCallingConfig.mode to VALIDATED if present
  if (innerRequest.toolConfig?.functionCallingConfig) {
    innerRequest.toolConfig.functionCallingConfig.mode = "VALIDATED";
  }

  // Normalize tools schema for v1internal
  if (Array.isArray(innerRequest?.tools)) {
    innerRequest.tools = normalizeTools(innerRequest.tools);
  }

  // Map preview model name based on thinking level (high/low)
  let mappedModelName = modelName;
  const levelForMapping = innerRequest?.generationConfig?.thinkingConfig?.thinkingLevel;
  if (modelName === "gemini-3-flash-preview") {
    mappedModelName = "gemini-3-flash";
  }
  if (modelName === "gemini-3-pro-preview" && typeof levelForMapping === "string") {
    const lvl = levelForMapping.toLowerCase();
    if (lvl === "high") mappedModelName = "gemini-3-pro-high";
    else if (lvl === "low") mappedModelName = "gemini-3-pro-low";
  }

  // Normalize thinkingLevel -> thinkingBudget for v1internal
  const thinkingCfg = innerRequest?.generationConfig?.thinkingConfig;
  if (thinkingCfg && typeof thinkingCfg === "object" && thinkingCfg.thinkingLevel) {
    const lvl = String(thinkingCfg.thinkingLevel).toLowerCase();
    if (lvl === "high") {
      thinkingCfg.thinkingBudget = -1;
    }
    delete thinkingCfg.thinkingLevel;
  }

  // Clamp thinkingBudget: 2.5-flash/web_search 上限 24576，其余模型不强制改动
  const hasGoogleSearchTool = Array.isArray(innerRequest?.tools) && innerRequest.tools.some((t) => t.googleSearch);
  const isFlashModel = hasGoogleSearchTool || (mappedModelName && mappedModelName.includes("gemini-2.5-flash"));
  if (thinkingCfg && typeof thinkingCfg === "object" && typeof thinkingCfg.thinkingBudget === "number") {
    if (isFlashModel && thinkingCfg.thinkingBudget > 24576) {
      thinkingCfg.thinkingBudget = 24576;
    }
  }

  // Match current behavior: force maxOutputTokens
  innerRequest.generationConfig.maxOutputTokens = 65535;

  // Derive requestType: image_gen for image model, web_search if googleSearch tool present, otherwise agent
  let requestType = "agent";
  if (mappedModelName === "gemini-3-pro-image") {
    requestType = "image_gen";
  } else if (hasGoogleSearchTool) {
    requestType = "web_search";
    // Force search requests to use 2.5 flash for built-in search behavior
    mappedModelName = "gemini-2.5-flash";
  }

  const wrappedBody = {
    project: projectId,
    requestId: `agent-${crypto.randomUUID()}`,
    request: innerRequest,
    model: mappedModelName,
    userAgent: "antigravity",
    requestType,
  };

  return { wrappedBody, mappedModelName, requestType, hasGoogleSearchTool };
}

/**
 * Unwrap v1internal response wrapper into standard Gemini shape.
 * Mirrors current logic in root server.js to preserve behavior.
 */
function unwrapResponse(payload) {
  if (payload && typeof payload === "object" && payload.response) {
    const merged = { ...payload.response };
    if (payload.traceId && !merged.traceId) {
      merged.traceId = payload.traceId;
    }
    return merged;
  }
  return payload;
}

/**
 * Create a stream that unwraps each SSE `data:` line payload.
 * Mirrors current root server.js behavior to preserve line handling.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @param {object} [options]
 * @param {(payload: any) => void} [options.onChunk] - Called with unwrapped payload for logging.
 */
function createUnwrapStream(body, options = {}) {
  const onChunk = typeof options.onChunk === "function" ? options.onChunk : null;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = body.getReader();

  return new ReadableStream({
    async start(controller) {
      let buffer = "";
      const pushLine = (line) => {
        if (line.startsWith("data:")) {
          const dataStr = line.slice(5).trim();
          if (!dataStr) {
            controller.enqueue(encoder.encode("data:\n\n"));
            return;
          }
          if (dataStr === "[DONE]") {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            return;
          }
          try {
            const parsed = JSON.parse(dataStr);
            const unwrapped = unwrapResponse(parsed);
            if (onChunk) onChunk(unwrapped);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(unwrapped)}\n\n`));
          } catch (err) {
            // Fallback to raw line if parsing fails
            controller.enqueue(encoder.encode(`${line}\n`));
          }
        } else {
          controller.enqueue(encoder.encode(`${line}\n`));
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (buffer) pushLine(buffer);
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (line === "") {
              controller.enqueue(encoder.encode("\n"));
            } else {
              pushLine(line);
            }
          }
        }
      } catch (err) {
        controller.error(err);
      } finally {
        controller.close();
      }
    },
  });
}

module.exports = {
  wrapRequest,
  normalizeTools,
  cleanSchema,
  uppercaseSchemaTypes,
  unwrapResponse,
  createUnwrapStream,
};
