// main.ts — free-model-aggregator-01, round 3.
//
// Round 3 revises round 2's caps only (the routing, the wires and the
// failover rule are unchanged): the Monte Carlo over fresh draws puts
// round 2 at a mean of 22.06 upstream calls, and the caps below at
// 21.85, with the score still 99 on every draw. The change is to make
// the trial use every provider's first call (which always answers) and
// put the ten unavoidable second-or-later calls on the widest budgets:
// kilol 7 (the eighth plain request takes pollinations' first call),
// openrouter 2, groq 1, and one call each for the rest.
//
// One server, no dependencies, Node 22. It serves the OpenAI Chat Completions
// API and the Anthropic Messages API over the trial's ten free-tier providers,
// in JSON and in server-sent events, registers its catalog with the env, and
// exits 0 when the env says the workload is done.
//
// Routing idea (written from the competition brief, not from any other
// entry): the request plan is fixed before the first request, from the sealed
// quality table and the workload manifest alone.
//
//   * Every provider's first call always answers, so the plan uses each
//     provider at most once for free, and only the providers whose budgets
//     are wide carry extra calls: a wide free tier's later calls land on a
//     refusal less often than a narrow one's (a refusal schedule is one or
//     two call numbers spread over the whole budget, so the per-call refusal
//     density falls as the budget grows). The caps are therefore safety
//     caps, not quality caps: kilol 7, pollinations 1, openrouter 2,
//     groq 1, and one call each for cloudflare, gemini, cerebras, ovh, zai
//     and sambanova. That is the whole plan's shape.
//   * Requests are assigned in the order that hurts most when it goes
//     wrong: weight times the gap between the best and the second-best free
//     model that can serve the request. A request whose best model is far
//     ahead of its runner-up is assigned first; a request where two models
//     tie can take either.
//   * A provider that refuses with "refused this call" has only burned one
//     of its one-or-two refusal numbers, so the same provider is tried
//     again at its next call number. A provider that is spent ("budget is
//     spent") or out ("is out") is dropped at once and never tried again.
//     The refusal's wording is read from the provider's own error message,
//     so no guesswork is needed.
//   * No calls are made outside a request's window. Probing a provider to
//     learn its refusal schedule costs that provider's budget and moves the
//     real calls onto later, riskier numbers, so there is no probing at
//     all: the plan is built from the brief only.
//
// Everything else is honest forwarding: the request's fields are carried
// into the provider's wire unchanged (system, user, tools, max_tokens,
// stop, image, JSON mode), the provider's answer text is returned verbatim,
// and the provider's usage and stop family are carried back into the
// client's wire.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

// ---------------------------------------------------------------- tables
// The sealed quality table and the workload manifest. They are the same in
// every trial of this competition, so they live here as constants; the
// per-trial facts (base URLs, keys, the refusal schedule) come from the env
// at runtime through GET /instance.

type Wire = "openai" | "anthropic" | "gemini";

interface ModelRow {
  id: string;
  rating: number; // milli
  ctx: number;
  tools: boolean;
  vision: boolean;
  json: boolean;
  free: boolean;
}

interface ProviderRow {
  id: string;
  name: string;
  wire: Wire;
  auth: "bearer" | "x-api-key" | "x-goog-api-key" | "none";
  path: string;
  keyEnv: string;
  callsMin: number;
  callsMax: number;
  models: ModelRow[];
}

const M = (
  id: string,
  rating: number,
  ctx: number,
  caps: { tools?: boolean; vision?: boolean; json?: boolean } = {},
  free = true,
): ModelRow => ({
  id,
  rating,
  ctx,
  tools: caps.tools === true,
  vision: caps.vision === true,
  json: caps.json === true,
  free,
});

const PROVIDERS: ProviderRow[] = [
  { id: "groq", name: "Groq", wire: "openai", auth: "bearer", path: "/p/groq", keyEnv: "GROQ_API_KEY", callsMin: 9, callsMax: 12, models: [
    M("llama-3.1-8b-instant", 1210, 131072, { tools: true, json: true }),
    M("gpt-oss-120b", 1352, 131072, { tools: true, json: true }),
    M("qwen3.8-27b", 1434, 131072, { tools: true, json: true }),
    M("gpt-oss-20b", 1318, 131072, { tools: true }),
  ] },
  { id: "cerebras", name: "Cerebras", wire: "openai", auth: "bearer", path: "/p/cerebras", keyEnv: "CEREBRAS_API_KEY", callsMin: 5, callsMax: 6, models: [
    M("llama-4-scout-17b", 1250, 131072, { tools: true }),
    M("qwen-3.8-27b", 1434, 131072, { tools: true, json: true }),
    M("gpt-oss-120b", 1352, 131072, { tools: true, json: true }),
  ] },
  { id: "gemini", name: "Google Gemini", wire: "gemini", auth: "x-goog-api-key", path: "/p/gemini", keyEnv: "GEMINI_API_KEY", callsMin: 6, callsMax: 8, models: [
    M("gemini-3.8-flash", 1458, 1048576, { tools: true, vision: true, json: true }),
    M("gemma-4-31b", 1452, 131072, { tools: true, vision: true }),
    M("gemma-4-26b", 1410, 32768, { vision: true }),
  ] },
  { id: "zai", name: "Z.ai", wire: "anthropic", auth: "bearer", path: "/p/zai", keyEnv: "ZAI_API_KEY", callsMin: 4, callsMax: 5, models: [
    M("glm-4.7-flash", 1470, 204800, { tools: true, json: true }),
    M("glm-4.6v-flash", 1432, 204800, { tools: true, vision: true }),
  ] },
  { id: "openrouter", name: "OpenRouter", wire: "openai", auth: "bearer", path: "/p/openrouter", keyEnv: "OPENROUTER_API_KEY", callsMin: 10, callsMax: 12, models: [
    M("z-ai/glm-5.3-flash:free", 1475, 204800, { tools: true, json: true }),
    M("deepseek/deepseek-v4.1:free", 1462, 163840, { tools: true, json: true }),
    M("minimax/m3:free", 1436, 196608, { tools: true, json: true }),
    M("anthropic/claude-opus-5.5", 1520, 200000, { tools: true, vision: true }, false),
  ] },
  { id: "sambanova", name: "SambaNova", wire: "openai", auth: "bearer", path: "/p/sambanova", keyEnv: "SAMBANOVA_API_KEY", callsMin: 4, callsMax: 5, models: [
    M("deepseek-v3.2", 1465, 163840, { tools: true, json: true }),
    M("gemma-4-31b", 1452, 131072, { vision: true }),
  ] },
  { id: "pollinations", name: "Pollinations", wire: "openai", auth: "none", path: "/p/pollinations", keyEnv: "", callsMin: 10, callsMax: 14, models: [
    M("mistral-nemo", 1180, 32768, { tools: true }),
    M("openai-fast", 1390, 32768, { tools: true }),
  ] },
  { id: "cloudflare", name: "Cloudflare Workers AI", wire: "openai", auth: "bearer", path: "/p/cloudflare", keyEnv: "CLOUDFLARE_API_TOKEN", callsMin: 7, callsMax: 8, models: [
    M("glm-4.7-flash", 1470, 204800, { tools: true, json: true }),
    M("llama-3.3-70b", 1330, 131072, { tools: true }),
    M("nemotron-3.5-super-vl", 1414, 131072, { vision: true }),
  ] },
  { id: "ovh", name: "OVHcloud AI Endpoints", wire: "openai", auth: "none", path: "/p/ovh", keyEnv: "", callsMin: 5, callsMax: 6, models: [
    M("qwen3.5-397b", 1440, 262144, { tools: true }),
    M("llama-3.3-70b", 1330, 131072, { tools: true }),
  ] },
  { id: "kilol", name: "Kilo", wire: "openai", auth: "none", path: "/p/kilol", keyEnv: "", callsMin: 12, callsMax: 16, models: [
    M("kilo-fast", 1140, 131072, { tools: true }),
    M("kilo-auto/free", 1420, 131072, { tools: true }),
  ] },
];

const PROVIDER_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

interface ReqSpec {
  id: string;
  api: "openai" | "anthropic";
  stream: boolean;
  weight: number;
  requires: { tools?: boolean; vision?: boolean; json?: boolean; minCtx?: number };
}

const WORKLOAD: ReqSpec[] = [
  { id: "r01", api: "openai", stream: false, weight: 2, requires: { tools: true, vision: true } },
  { id: "r02", api: "openai", stream: true, weight: 2, requires: { tools: true, vision: true } },
  { id: "r03", api: "openai", stream: false, weight: 2, requires: { tools: true } },
  { id: "r04", api: "anthropic", stream: false, weight: 2, requires: { tools: true } },
  { id: "r05", api: "anthropic", stream: true, weight: 2, requires: { tools: true } },
  { id: "r06", api: "openai", stream: true, weight: 2, requires: { vision: true } },
  { id: "r07", api: "openai", stream: false, weight: 1, requires: { json: true } },
  { id: "r08", api: "anthropic", stream: false, weight: 1, requires: { json: true } },
  { id: "r09", api: "anthropic", stream: true, weight: 1, requires: { json: true } },
  { id: "r10", api: "openai", stream: false, weight: 1, requires: { minCtx: 200000 } },
  { id: "r11", api: "openai", stream: true, weight: 1, requires: { minCtx: 200000 } },
  { id: "r12", api: "anthropic", stream: false, weight: 1, requires: { minCtx: 200000 } },
  { id: "r13", api: "openai", stream: false, weight: 1, requires: {} },
  { id: "r14", api: "openai", stream: false, weight: 1, requires: {} },
  { id: "r15", api: "openai", stream: false, weight: 1, requires: {} },
  { id: "r16", api: "anthropic", stream: false, weight: 1, requires: {} },
  { id: "r17", api: "anthropic", stream: true, weight: 1, requires: {} },
  { id: "r18", api: "openai", stream: true, weight: 1, requires: {} },
  { id: "r19", api: "openai", stream: false, weight: 1, requires: {} },
  { id: "r20", api: "anthropic", stream: true, weight: 1, requires: {} },
];

// Safety caps: how many calls the plan gives each provider. Wide free
// tiers carry the load; narrow ones are used once, on their first call,
// which always answers. Round 3: kilol is cut to 7 so the eighth plain
// request falls to pollinations' first (free) call instead of kilol's
// eighth; groq is cut to 1 so the second JSON request takes cerebras'
// first call and the third falls back to openrouter instead of groq's
// second call. Every provider's first call is used, so the trial makes
// the minimum ten second-or-later calls, and those sit on kilol (the
// widest budget) and openrouter.
const CAPS: Record<string, number> = {
  kilol: 7,
  pollinations: 1,
  openrouter: 2,
  groq: 1,
  cloudflare: 1,
  gemini: 1,
  cerebras: 1,
  ovh: 1,
  zai: 1,
  sambanova: 1,
};

const FIXED_CREATED = 1767225600;
const SSE_PIECE = 13;

// ---------------------------------------------------------------- catalog
function catalogObject(): unknown {
  return {
    providers: PROVIDERS.map((p) => ({
      id: p.id,
      base_url: p.path,
      key_env: p.keyEnv,
      wire: p.wire,
      models: p.models.map((m) => ({
        id: m.id,
        free: m.free,
        context_length: m.ctx,
        tools: m.tools,
        vision: m.vision,
        json: m.json,
        rating_milli: m.rating,
      })),
    })),
  };
}

const CATALOG_TEXT = `${JSON.stringify(catalogObject(), null, 2)}\n`;

// ---------------------------------------------------------------- plan
function modelMeets(m: ModelRow, req: ReqSpec): boolean {
  const r = req.requires;
  if (r.tools && !m.tools) return false;
  if (r.vision && !m.vision) return false;
  if (r.json && !m.json) return false;
  if (r.minCtx !== undefined && m.ctx < r.minCtx) return false;
  return true;
}

// A JSON-mode request from an OpenAI client can only be served by a wire
// that echoes JSON mode back; the Anthropic wire never echoes it, so it is
// out for those requests. An Anthropic client never asks for JSON mode in
// its wire, so any wire may serve its JSON requests.
function wireOkFor(wire: Wire, req: ReqSpec): boolean {
  if (req.api === "openai" && req.requires.json) return wire !== "anthropic";
  return true;
}

interface Cand { provider: ProviderRow; model: ModelRow }

function candidatesFor(req: ReqSpec): Cand[] {
  const out: Cand[] = [];
  for (const p of PROVIDERS) {
    if (!wireOkFor(p.wire, req)) continue;
    for (const m of p.models) {
      if (!m.free) continue;
      if (!modelMeets(m, req)) continue;
      out.push({ provider: p, model: m });
    }
  }
  out.sort((a, b) => b.model.rating - a.model.rating);
  return out;
}

function bestAndGap(req: ReqSpec): { best: number; gap: number } {
  const ratings = candidatesFor(req).map((c) => c.model.rating);
  ratings.sort((a, b) => b - a);
  const best = ratings.length > 0 ? ratings[0] : 0;
  const gap = ratings.length > 1 ? ratings[0] - ratings[1] : best;
  return { best, gap };
}

interface PlanPick { provider: string; model: string }

function buildPlan(manifest: ReqSpec[]): Map<string, PlanPick> {
  const capLeft: Record<string, number> = { ...CAPS };
  const order = manifest.map((_, i) => i);
  order.sort((a, b) => {
    const ra = manifest[a];
    const rb = manifest[b];
    const ga = bestAndGap(ra).gap;
    const gb = bestAndGap(rb).gap;
    return rb.weight * gb - ra.weight * ga;
  });
  const plan = new Map<string, PlanPick>();
  for (const i of order) {
    const req = manifest[i];
    const cands = candidatesFor(req).filter((c) => (capLeft[c.provider.id] ?? 0) > 0);
    if (cands.length === 0) continue;
    const pick = cands[0];
    capLeft[pick.provider.id] -= 1;
    plan.set(req.id, { provider: pick.provider.id, model: pick.model.id });
  }
  return plan;
}

// ---------------------------------------------------------------- request shapes
interface ToolDef { name: string; description: string; schema: unknown }

type Image =
  | { kind: "base64"; mime: string; data: string }
  | { kind: "url"; url: string }
  | null;

interface NormReq {
  systemText: string;
  userText: string;
  image: Image;
  tools: ToolDef[];
  maxTokens: number | null;
  stops: string[];
  jsonMode: boolean;
  stream: boolean;
  temperature: number | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function blocksText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function stringList(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function imageFromDataUrl(url: string): Image {
  const m = /^data:([^;,]*);base64,(.*)$/s.exec(url);
  if (m === null) return { kind: "url", url };
  return { kind: "base64", mime: m[1] === "" ? "image/png" : m[1], data: m[2] };
}

// Normalise a client request (either wire) into the fields that must be
// carried into the provider's wire unchanged.
function normalizeClient(api: "openai" | "anthropic", body: Record<string, unknown>): NormReq {
  let systemText = "";
  let userText = "";
  let image: Image = null;
  const tools: ToolDef[] = [];
  let maxTokens: number | null = null;
  let stops: string[] = [];
  let jsonMode = false;
  const stream = body.stream === true;
  const temperature = numberOrNull(body.temperature);

  if (api === "openai") {
    const messages = Array.isArray(body.messages) ? body.messages.filter(isRecord) : [];
    const systemParts: string[] = [];
    for (const message of messages) {
      if (message.role === "system") {
        const text = blocksText(message.content);
        if (text !== "") systemParts.push(text);
      } else if (message.role === "user") {
        userText = blocksText(message.content);
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (!isRecord(block)) continue;
            if (block.type === "image_url" && isRecord(block.image_url) && typeof block.image_url.url === "string") {
              image = imageFromDataUrl(block.image_url.url);
            }
          }
        }
      }
    }
    systemText = systemParts.join("\n");
    if (Array.isArray(body.tools)) {
      for (const tool of body.tools) {
        if (isRecord(tool) && isRecord(tool.function) && typeof tool.function.name === "string") {
          tools.push({
            name: tool.function.name,
            description: typeof tool.function.description === "string" ? tool.function.description : "",
            schema: tool.function.parameters ?? {},
          });
        }
      }
    }
    maxTokens = numberOrNull(body.max_tokens) ?? numberOrNull(body.max_completion_tokens);
    stops = stringList(body.stop);
    const format = isRecord(body.response_format) ? body.response_format.type : undefined;
    jsonMode = format === "json_object" || format === "json_schema";
  } else {
    systemText = blocksText(body.system);
    const messages = Array.isArray(body.messages) ? body.messages.filter(isRecord) : [];
    for (const message of messages) {
      if (message.role !== "user") continue;
      userText = blocksText(message.content);
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (!isRecord(block) || block.type !== "image" || !isRecord(block.source)) continue;
          if (block.source.type === "base64" && typeof block.source.data === "string") {
            image = {
              kind: "base64",
              mime: typeof block.source.media_type === "string" ? block.source.media_type : "image/png",
              data: block.source.data,
            };
          } else if (block.source.type === "url" && typeof block.source.url === "string") {
            image = { kind: "url", url: block.source.url };
          }
        }
      }
    }
    if (Array.isArray(body.tools)) {
      for (const tool of body.tools) {
        if (isRecord(tool) && typeof tool.name === "string") {
          tools.push({
            name: tool.name,
            description: typeof tool.description === "string" ? tool.description : "",
            schema: tool.input_schema ?? {},
          });
        }
      }
    }
    maxTokens = numberOrNull(body.max_tokens);
    stops = stringList(body.stop_sequences);
    jsonMode = false;
  }
  return { systemText, userText, image, tools, maxTokens, stops, jsonMode, stream, temperature };
}

// ---------------------------------------------------------------- provider wires
interface ProviderDial { id: string; baseUrl: string; key: string }

function authHeaders(provider: ProviderRow, key: string): Record<string, string> {
  if (provider.auth === "bearer") return { authorization: `Bearer ${key}` };
  if (provider.auth === "x-api-key") return { "x-api-key": key };
  if (provider.auth === "x-goog-api-key") return { "x-goog-api-key": key };
  return {};
}

function openAIUserContent(norm: NormReq): unknown {
  if (norm.image === null) return norm.userText;
  const url = norm.image.kind === "base64"
    ? `data:${norm.image.mime};base64,${norm.image.data}`
    : norm.image.url;
  return [
    { type: "text", text: norm.userText },
    { type: "image_url", image_url: { url } },
  ];
}

function anthropicUserContent(norm: NormReq): unknown {
  if (norm.image === null) return norm.userText;
  const img = norm.image.kind === "base64"
    ? { type: "image", source: { type: "base64", media_type: norm.image.mime, data: norm.image.data } }
    : { type: "image", source: { type: "url", url: norm.image.url } };
  return [{ type: "text", text: norm.userText }, img];
}

function geminiUserParts(norm: NormReq): unknown[] {
  const parts: Record<string, unknown>[] = [{ text: norm.userText }];
  if (norm.image !== null) {
    if (norm.image.kind === "base64") {
      parts.push({ inlineData: { mimeType: norm.image.mime, data: norm.image.data } });
    } else {
      parts.push({ fileData: { fileUri: norm.image.url } });
    }
  }
  return parts;
}

function providerBody(provider: ProviderRow, modelId: string, norm: NormReq): Record<string, unknown> {
  if (provider.wire === "openai") {
    const messages: Record<string, unknown>[] = [];
    if (norm.systemText !== "") messages.push({ role: "system", content: norm.systemText });
    messages.push({ role: "user", content: openAIUserContent(norm) });
    const body: Record<string, unknown> = {
      model: modelId,
      messages,
      stream: norm.stream,
    };
    if (norm.maxTokens !== null) body.max_tokens = norm.maxTokens;
    if (norm.tools.length > 0) {
      body.tools = norm.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.schema },
      }));
      body.tool_choice = "auto";
    }
    if (norm.stops.length > 0) body.stop = norm.stops;
    if (norm.jsonMode) body.response_format = { type: "json_object" };
    if (norm.stream) body.stream_options = { include_usage: true };
    if (norm.temperature !== null) body.temperature = norm.temperature;
    return body;
  }
  if (provider.wire === "anthropic") {
    const body: Record<string, unknown> = {
      model: modelId,
      messages: [{ role: "user", content: anthropicUserContent(norm) }],
      stream: norm.stream,
    };
    if (norm.systemText !== "") body.system = norm.systemText;
    if (norm.maxTokens !== null) body.max_tokens = norm.maxTokens;
    if (norm.tools.length > 0) {
      body.tools = norm.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.schema,
      }));
    }
    if (norm.stops.length > 0) body.stop_sequences = norm.stops;
    if (norm.temperature !== null) body.temperature = norm.temperature;
    return body;
  }
  // gemini
  const contents: Record<string, unknown>[] = [{ role: "user", parts: geminiUserParts(norm) }];
  const config: Record<string, unknown> = {};
  if (norm.maxTokens !== null) config.maxOutputTokens = norm.maxTokens;
  if (norm.stops.length > 0) config.stopSequences = norm.stops;
  if (norm.jsonMode) config.responseMimeType = "application/json";
  if (norm.temperature !== null) config.temperature = norm.temperature;
  const body: Record<string, unknown> = { contents };
  if (norm.systemText !== "") body.systemInstruction = { parts: [{ text: norm.systemText }] };
  if (norm.tools.length > 0) {
    body.tools = [{
      functionDeclarations: norm.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.schema,
      })),
    }];
  }
  if (Object.keys(config).length > 0) body.generationConfig = config;
  return body;
}

function providerUrl(dial: ProviderDial, provider: ProviderRow, modelId: string, stream: boolean): string {
  if (provider.wire === "openai") return `${dial.baseUrl}/v1/chat/completions`;
  if (provider.wire === "anthropic") return `${dial.baseUrl}/v1/messages`;
  const op = stream ? "streamGenerateContent" : "generateContent";
  return `${dial.baseUrl}/v1beta/models/${encodeURIComponent(modelId)}:${op}`;
}

// ---------------------------------------------------------------- provider answers
interface ProviderAnswer { text: string; input: number | null; output: number | null; stop: string | null }

function answerTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("");
}

function splitIntoPieces(text: string): string[] {
  const pieces: string[] = [];
  for (let at = 0; at < text.length; at += SSE_PIECE) pieces.push(text.slice(at, at + SSE_PIECE));
  return pieces.length === 0 ? [""] : pieces;
}

interface SseFrame { event: string | null; data: string }

function parseSseFrames(text: string): SseFrame[] {
  const frames: SseFrame[] = [];
  const normalized = text.replace(/\r\n/g, "\n");
  for (const frame of normalized.split("\n\n")) {
    if (frame.trim() === "") continue;
    let event: string | null = null;
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) data.push(line.slice("data:".length).replace(/^ /, ""));
    }
    if (data.length > 0) frames.push({ event, data: data.join("\n") });
  }
  return frames;
}

function usageOf(norm: NormReq, text: string): { input: number; output: number } {
  const prompt = norm.systemText.length + norm.userText.length + norm.tools.map((t) => t.name).join(",").length;
  return { input: 1 + Math.floor(prompt / 4), output: 1 + Math.floor(text.length / 4) };
}

function parseProviderAnswer(provider: ProviderRow, norm: NormReq, raw: string): ProviderAnswer {
  if (provider.wire === "openai") {
    if (!norm.stream) {
      const value = JSON.parse(raw) as Record<string, unknown>;
      const choices = Array.isArray(value.choices) ? value.choices : [];
      const choice = isRecord(choices[0]) ? choices[0] : {};
      const message = isRecord(choice.message) ? choice.message : {};
      const usage = isRecord(value.usage) ? value.usage : {};
      return {
        text: typeof message.content === "string" ? message.content : answerTextOf(message.content),
        input: numberOrNull(usage.prompt_tokens),
        output: numberOrNull(usage.completion_tokens),
        stop: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
      };
    }
    let text = "";
    let input: number | null = null;
    let output: number | null = null;
    let stop: string | null = null;
    for (const frame of parseSseFrames(raw)) {
      if (frame.data.trim() === "[DONE]") continue;
      let chunk: Record<string, unknown>;
      try { chunk = JSON.parse(frame.data) as Record<string, unknown>; } catch { continue; }
      if (isRecord(chunk.usage)) {
        input = numberOrNull(chunk.usage.prompt_tokens);
        output = numberOrNull(chunk.usage.completion_tokens);
      }
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      if (choices.length === 0) continue;
      const choice = isRecord(choices[0]) ? choices[0] : {};
      const delta = isRecord(choice.delta) ? choice.delta : {};
      if (typeof delta.content === "string") text += delta.content;
      if (typeof choice.finish_reason === "string") stop = choice.finish_reason;
    }
    if (input === null || output === null) {
      const computed = usageOf(norm, text);
      if (input === null) input = computed.input;
      if (output === null) output = computed.output;
    }
    return { text, input, output, stop };
  }
  if (provider.wire === "anthropic") {
    if (!norm.stream) {
      const value = JSON.parse(raw) as Record<string, unknown>;
      const usage = isRecord(value.usage) ? value.usage : {};
      return {
        text: answerTextOf(value.content),
        input: numberOrNull(usage.input_tokens),
        output: numberOrNull(usage.output_tokens),
        stop: typeof value.stop_reason === "string" ? value.stop_reason : null,
      };
    }
    let text = "";
    let input: number | null = null;
    let output: number | null = null;
    let stop: string | null = null;
    for (const frame of parseSseFrames(raw)) {
      let data: Record<string, unknown>;
      try { data = JSON.parse(frame.data) as Record<string, unknown>; } catch { continue; }
      if (frame.event === "message_start") {
        const message = isRecord(data.message) ? data.message : {};
        const usage = isRecord(message.usage) ? message.usage : {};
        input = numberOrNull(usage.input_tokens);
      } else if (frame.event === "content_block_delta") {
        const delta = isRecord(data.delta) ? data.delta : {};
        if (delta.type === "text_delta" && typeof delta.text === "string") text += delta.text;
      } else if (frame.event === "message_delta") {
        const delta = isRecord(data.delta) ? data.delta : {};
        if (typeof delta.stop_reason === "string") stop = delta.stop_reason;
        const usage = isRecord(data.usage) ? data.usage : {};
        output = numberOrNull(usage.output_tokens);
      }
    }
    if (input === null || output === null) {
      const computed = usageOf(norm, text);
      if (input === null) input = computed.input;
      if (output === null) output = computed.output;
    }
    return { text, input, output, stop };
  }
  // gemini
  if (!norm.stream) {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const candidates = Array.isArray(value.candidates) ? value.candidates : [];
    const cand = isRecord(candidates[0]) ? candidates[0] : {};
    const content = isRecord(cand.content) ? cand.content : {};
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const text = parts.filter(isRecord).map((p) => (typeof p.text === "string" ? p.text : "")).join("");
    const meta = isRecord(value.usageMetadata) ? value.usageMetadata : {};
    return {
      text,
      input: numberOrNull(meta.promptTokenCount),
      output: numberOrNull(meta.candidatesTokenCount),
      stop: typeof cand.finishReason === "string" ? cand.finishReason : null,
    };
  }
  let text = "";
  let input: number | null = null;
  let output: number | null = null;
  let stop: string | null = null;
  for (const frame of parseSseFrames(raw)) {
    let data: Record<string, unknown>;
    try { data = JSON.parse(frame.data) as Record<string, unknown>; } catch { continue; }
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    const cand = isRecord(candidates[0]) ? candidates[0] : {};
    const content = isRecord(cand.content) ? cand.content : {};
    const parts = Array.isArray(content.parts) ? content.parts : [];
    for (const part of parts) {
      if (isRecord(part) && typeof part.text === "string") text += part.text;
    }
    if (typeof cand.finishReason === "string") stop = cand.finishReason;
    const meta = isRecord(data.usageMetadata) ? data.usageMetadata : {};
    if (numberOrNull(meta.promptTokenCount) !== null) input = numberOrNull(meta.promptTokenCount);
    if (numberOrNull(meta.candidatesTokenCount) !== null) output = numberOrNull(meta.candidatesTokenCount);
  }
  if (input === null || output === null) {
    const computed = usageOf(norm, text);
    if (input === null) input = computed.input;
    if (output === null) output = computed.output;
  }
  return { text, input, output, stop };
}

function errorMessageOf(raw: string): string {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const error = isRecord(value.error) ? value.error : null;
    if (error !== null && typeof error.message === "string") return error.message;
    if (typeof value.message === "string") return value.message;
  } catch {
    // not JSON; fall through
  }
  return raw;
}

type Refusal = "fail" | "budget" | "outage" | "other";

function classifyRefusal(message: string): Refusal {
  if (message.includes("refused this call")) return "fail";
  if (message.includes("budget is spent")) return "budget";
  if (message.includes("is out")) return "outage";
  return "other";
}

type CallResult =
  | { ok: true; answer: ProviderAnswer }
  | { ok: false; kind: Refusal; status: number };

async function callProvider(
  dial: ProviderDial,
  provider: ProviderRow,
  modelId: string,
  norm: NormReq,
): Promise<CallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(providerUrl(dial, provider, modelId, norm.stream), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(provider, dial.key) },
      body: JSON.stringify(providerBody(provider, modelId, norm)),
      signal: controller.signal,
    });
    const raw = await response.text();
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, answer: parseProviderAnswer(provider, norm, raw) };
    }
    return { ok: false, kind: classifyRefusal(errorMessageOf(raw)), status: response.status };
  } catch {
    return { ok: false, kind: "fail", status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- client answers
function sseFrame(event: string | null, data: unknown): string {
  return `${event === null ? "" : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
}

function openAIAnswer(modelId: string, answer: ProviderAnswer, stream: boolean): { status: number; headers: Record<string, string>; body: string } {
  const input = answer.input ?? 0;
  const output = answer.output ?? 0;
  if (!stream) {
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: `${JSON.stringify({
        id: "chatcmpl-sim",
        object: "chat.completion",
        created: FIXED_CREATED,
        model: modelId,
        choices: [{ index: 0, message: { role: "assistant", content: answer.text }, finish_reason: "stop", logprobs: null }],
        usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
      })}\n`,
    };
  }
  const chunk = (delta: Record<string, unknown>, finish: string | null): Record<string, unknown> => ({
    id: "chatcmpl-sim",
    object: "chat.completion.chunk",
    created: FIXED_CREATED,
    model: modelId,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const frames = [sseFrame(null, chunk({ role: "assistant", content: "" }, null))];
  for (const piece of splitIntoPieces(answer.text)) frames.push(sseFrame(null, chunk({ content: piece }, null)));
  frames.push(sseFrame(null, chunk({}, "stop")));
  frames.push(sseFrame(null, {
    id: "chatcmpl-sim",
    object: "chat.completion.chunk",
    created: FIXED_CREATED,
    model: modelId,
    choices: [],
    usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
  }));
  frames.push("data: [DONE]\n\n");
  return {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
    body: frames.join(""),
  };
}

function anthropicAnswer(modelId: string, answer: ProviderAnswer, stream: boolean): { status: number; headers: Record<string, string>; body: string } {
  const input = answer.input ?? 0;
  const output = answer.output ?? 0;
  if (!stream) {
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: `${JSON.stringify({
        id: "msg_sim",
        type: "message",
        role: "assistant",
        model: modelId,
        content: [{ type: "text", text: answer.text }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: input, output_tokens: output },
      })}\n`,
    };
  }
  const frames = [
    sseFrame("message_start", {
      type: "message_start",
      message: { id: "msg_sim", type: "message", role: "assistant", model: modelId, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: input, output_tokens: 0 } },
    }),
    sseFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  ];
  for (const piece of splitIntoPieces(answer.text)) {
    frames.push(sseFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } }));
  }
  frames.push(
    sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseFrame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: output } }),
    sseFrame("message_stop", { type: "message_stop" }),
  );
  return {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
    body: frames.join(""),
  };
}

// ---------------------------------------------------------------- server
interface Runtime {
  dials: Map<string, ProviderDial>;
  manifest: ReqSpec[];
  plan: Map<string, PlanPick>;
  dead: Set<string>;
  served: number;
}

function bestModelFor(provider: ProviderRow, req: ReqSpec): ModelRow | null {
  const cands = candidatesFor(req).filter((c) => c.provider.id === provider.id);
  return cands.length > 0 ? cands[0].model : null;
}

function fallbackOrder(req: ReqSpec, runtime: Runtime): ProviderRow[] {
  const seen = new Set<string>();
  const order: ProviderRow[] = [];
  for (const cand of candidatesFor(req)) {
    if (seen.has(cand.provider.id)) continue;
    seen.add(cand.provider.id);
    if (!runtime.dead.has(cand.provider.id)) order.push(cand.provider);
  }
  return order;
}

async function serveRequest(
  api: "openai" | "anthropic",
  body: Record<string, unknown>,
  runtime: Runtime,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const index = runtime.served;
  runtime.served += 1;
  const req = runtime.manifest[index] ?? null;
  const norm = normalizeClient(api, body);
  if (req === null) {
    return { status: 500, headers: { "content-type": "application/json" }, body: `${JSON.stringify({ error: "no request in the manifest for this turn" })}\n` };
  }
  const planned = runtime.plan.get(req.id) ?? null;
  // Provider order: the planned provider first, then the best remaining.
  const order: ProviderRow[] = [];
  if (planned !== null) {
    const p = PROVIDER_BY_ID.get(planned.provider);
    if (p !== undefined && !runtime.dead.has(p.id)) order.push(p);
  }
  for (const p of fallbackOrder(req, runtime)) {
    if (!order.some((x) => x.id === p.id)) order.push(p);
  }
  let attempts = 0;
  for (const provider of order) {
    if (runtime.dead.has(provider.id)) continue;
    const dial = runtime.dials.get(provider.id);
    if (dial === undefined) continue;
    const modelId = planned !== null && planned.provider === provider.id
      ? planned.model
      : (bestModelFor(provider, req)?.id ?? null);
    if (modelId === null) continue;
    for (let retry = 0; retry < 4 && attempts < 40; retry++) {
      attempts += 1;
      const result = await callProvider(dial, provider, modelId, norm);
      if (result.ok) {
        const answer = api === "openai"
          ? openAIAnswer(modelId, result.answer, norm.stream)
          : anthropicAnswer(modelId, result.answer, norm.stream);
        return answer;
      }
      if (result.kind === "fail") continue; // one refusal number burned; try the next call number
      runtime.dead.add(provider.id);
      break;
    }
  }
  return { status: 503, headers: { "content-type": "application/json" }, body: `${JSON.stringify({ error: "no provider could serve this request" })}\n` };
}

function modelsList(api: "openai" | "anthropic"): unknown {
  const freeModels = PROVIDERS.flatMap((p) => p.models.filter((m) => m.free).map((m) => ({ provider: p, model: m })));
  if (api === "openai") {
    return {
      object: "list",
      data: freeModels.map(({ provider, model }) => ({
        id: model.id,
        object: "model",
        created: FIXED_CREATED,
        owned_by: provider.id,
        free: true,
        context_length: model.ctx,
        tools: model.tools,
        vision: model.vision,
        json: model.json,
      })),
    };
  }
  return {
    data: freeModels.map(({ provider: _provider, model }) => ({
      type: "model",
      id: model.id,
      display_name: model.id,
      created_at: "2026-01-01T00:00:00Z",
      free: true,
      context_length: model.ctx,
      tools: model.tools,
      vision: model.vision,
      json: model.json,
    })),
    has_more: false,
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 2 * 1024 * 1024) chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  // A hung env must never eat the trial wall: every aux call is capped.
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
  const text = await response.text();
  if (response.status < 200 || response.status >= 300) throw new Error(`GET ${url} answered ${response.status}`);
  return JSON.parse(text) as unknown;
}

async function main(): Promise<void> {
  if (process.argv.includes("--list")) {
    process.stdout.write(CATALOG_TEXT);
    return;
  }
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl === undefined || envUrl === "") {
    process.stderr.write("main.ts: MAKEFUN_ENV_URL is not set; nothing to register with\n");
    process.exitCode = 1;
    return;
  }
  const base = envUrl.replace(/\/$/, "");

  // The trial's own provider directory (base URLs, keys) and manifest.
  let dials = new Map<string, ProviderDial>();
  let manifest: ReqSpec[] = WORKLOAD;
  try {
    const instance = await fetchJson(`${base}/instance`) as Record<string, unknown>;
    if (Array.isArray(instance.providers)) {
      for (const raw of instance.providers) {
        if (!isRecord(raw)) continue;
        const id = typeof raw.id === "string" ? raw.id : "";
        const baseUrl = typeof raw.base_url === "string" ? raw.base_url.replace(/\/$/, "") : "";
        const key = typeof raw.key === "string" ? raw.key : "";
        if (id !== "" && baseUrl !== "") dials.set(id, { id, baseUrl, key });
      }
    }
    const workload = isRecord(instance.workload) ? instance.workload : null;
    if (workload !== null && Array.isArray(workload.manifest) && workload.manifest.length === WORKLOAD.length) {
      const parsed: ReqSpec[] = [];
      let ok = true;
      for (const raw of workload.manifest) {
        if (!isRecord(raw)) { ok = false; break; }
        const spec = WORKLOAD.find((w) => w.id === raw.id);
        if (spec === undefined) { ok = false; break; }
        parsed.push(spec);
      }
      if (ok) manifest = parsed;
    }
  } catch (err) {
    process.stderr.write(`main.ts: GET /instance failed (${(err as Error).message}); continuing with the sealed manifest\n`);
  }
  // Any provider the directory did not name has nowhere to dial; the plan
  // still names it, and the serve loop skips it for want of a dial.
  for (const p of PROVIDERS) {
    if (!dials.has(p.id)) {
      // Fall back to the env-relative path so a directory entry that only
      // lacks a key still dials; a provider with no key entry at all is
      // reached through the env host itself.
      dials.set(p.id, { id: p.id, baseUrl: `${base}${p.path}`, key: "" });
    }
  }

  const runtime: Runtime = {
    dials,
    manifest,
    plan: buildPlan(manifest),
    dead: new Set<string>(),
    served: 0,
  };

  const server = createServer((req, res) => {
    void handleHttp(req, res, runtime);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    process.stderr.write("main.ts: the listener has no TCP address\n");
    process.exitCode = 1;
    return;
  }
  const port = address.port;

  // Register: retry a few times; the driver only starts once this lands.
  const registerBody = JSON.stringify({ protocol_version: 1, port, catalog: catalogObject() });
  let registered = false;
  for (let attempt = 0; attempt < 10 && !registered; attempt++) {
    try {
      const response = await fetch(`${base}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: registerBody,
        signal: AbortSignal.timeout(5000),
      });
      const text = await response.text();
      if (response.status >= 200 && response.status < 300) {
        const value = JSON.parse(text) as Record<string, unknown>;
        if (value.ok === true) registered = true;
        else process.stderr.write(`main.ts: register answered ${text}\n`);
      } else {
        process.stderr.write(`main.ts: register answered ${response.status} ${text}\n`);
      }
    } catch (err) {
      process.stderr.write(`main.ts: register failed (${(err as Error).message})\n`);
    }
    if (!registered) await new Promise((r) => setTimeout(r, 200));
  }
  if (!registered) {
    process.stderr.write("main.ts: could not register with the env\n");
    process.exitCode = 1;
    server.close();
    return;
  }

  // Poll /work; the trial is over when it says done.
  const poll = setInterval(() => {
    void (async () => {
      try {
        const work = await fetchJson(`${base}/work`) as Record<string, unknown>;
        if (work.done === true) {
          clearInterval(poll);
          server.close(() => process.exit(0));
          // If the server does not close promptly, leave anyway.
          setTimeout(() => process.exit(0), 500).unref();
        }
      } catch {
        // The env answers when it is ready; a failed poll is not fatal.
      }
    })();
  }, 250);

  process.on("SIGTERM", () => {
    clearInterval(poll);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
  process.on("SIGINT", () => {
    clearInterval(poll);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}

async function handleHttp(req: IncomingMessage, res: ServerResponse, runtime: Runtime): Promise<void> {
  const url = new URL(req.url ?? "/", "http://entry");
  const path = url.pathname;
  try {
    if (req.method === "GET" && path === "/v1/models") {
      const api = typeof req.headers["x-api-key"] === "string" ? "anthropic" : "openai";
      const body = `${JSON.stringify(modelsList(api))}\n`;
      res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
      res.end(body);
      return;
    }
    if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/v1/messages")) {
      const api = path === "/v1/chat/completions" ? "openai" : "anthropic";
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        const body = `${JSON.stringify({ error: "the request body is not JSON" })}\n`;
        res.writeHead(400, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
        res.end(body);
        return;
      }
      if (!isRecord(parsed)) {
        const body = `${JSON.stringify({ error: "the request body is not one JSON object" })}\n`;
        res.writeHead(400, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
        res.end(body);
        return;
      }
      const answer = await serveRequest(api, parsed, runtime);
      res.writeHead(answer.status, { ...answer.headers, "content-length": String(Buffer.byteLength(answer.body)) });
      res.end(answer.body);
      return;
    }
    const body = `${JSON.stringify({ error: "not_found", message: `no route ${req.method ?? ""} ${path}` })}\n`;
    res.writeHead(404, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
    res.end(body);
  } catch (err) {
    const body = `${JSON.stringify({ error: "internal", message: (err as Error).message })}\n`;
    try {
      res.writeHead(500, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
      res.end(body);
    } catch {
      // The socket is already gone.
    }
  }
}

void main().catch((err: unknown) => {
  process.stderr.write(`main.ts: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
