// api/stream.ts
// Vercel Node.js Function that streams Server-Sent Events (SSE)
// Designed to be called from Bubble's API Connector (Data type: Stream).

import { Agent } from "@mastra/core/agent";
import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { openai } from "@ai-sdk/openai";

// ----- Mastra: simple agent
const agent = new Agent({
  name: "assistant",
  instructions: "あなたは段取りの良いアシスタント。各ステップの意図を短く説明しながら進めてください。",
  model: openai("gpt-4o-mini"),
});

// ----- Mastra: multi-step workflow
const Input = z.object({ prompt: z.string() });

const plan = createStep({
  id: "plan",
  input: Input,
  run: async ({ input }) => {
    const out = await agent.generate(`ユーザーの依頼: ${input.prompt}\nこの依頼を3ステップに分解し、各ステップの目的を一行で説明してください。`);
    return out.text;
  },
});

const act = createStep({
  id: "act",
  input: Input,
  run: async ({ input }) => {
    const out = await agent.generate(`上の計画に基づき、依頼「${input.prompt}」のドラフトを短く作成してください。`);
    return out.text;
  },
});

const reflect = createStep({
  id: "reflect",
  input: Input,
  run: async ({ input }) => {
    const out = await agent.generate(`ドラフトを読み、明確さと簡潔さを高めて最終結果を返してください。依頼: ${input.prompt}`);
    return out.text;
  },
});

const workflow = createWorkflow({ id: "multi-step", input: Input })
  .then(plan)
  .then(act)
  .then(reflect)
  .commit();

// ----- CORS helpers (Bubble -> Vercel)
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*", // プロトタイプ用。必要に応じて Bubble のドメインに限定
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

const encoder = new TextEncoder();
function sse(event: string, data: any) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function POST(request: Request) {
  let prompt = "";
  try {
    const body = await request.json();
    prompt = body?.prompt ?? "";
  } catch {}

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(sse("ready", { ok: true }));
      try {
        const run = await workflow.createRunAsync();
        const it = await run.stream({ inputData: { prompt } });

        for await (const evt of it) {
          // Forward workflow events (step started/finished, partials, etc.)
          controller.enqueue(sse("progress", evt));
        }

        const result = await run.result();
        controller.enqueue(sse("final", result));
      } catch (e: any) {
        controller.enqueue(sse("error", { message: e?.message || "unexpected error" }));
      } finally {
        controller.enqueue(sse("done", { ok: true }));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      ...corsHeaders(),
    },
  });
}
