// /api/stream.ts
// Vercel Functions 形式（default export）。Bubble の API Connector（Data type: Stream）想定。
// Mastra の workflow を実行し、その進捗を SSE で逐次送ります。
// 重要：Mastraの .stream() が版によって戻り値が違うため、.events があればそれを、なければ本体を for-await します。

import { Agent } from "@mastra/core/agent";
import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { openai } from "@ai-sdk/openai";

// ---- Mastra: エージェント
const agent = new Agent({
  name: "assistant",
  instructions:
    "あなたは段取りの良いアシスタント。各ステップの意図を短く説明しながら進めてください。",
  model: openai("gpt-4o-mini"),
});

// ---- Mastra: マルチステップ Workflow
const Input = z.object({ prompt: z.string() });

const plan = createStep({
  id: "plan",
  input: Input,
  run: async ({ input }) => {
    const out = await agent.generate(
      `ユーザーの依頼: ${input.prompt}\nこの依頼を3ステップに分解し、各ステップの目的を一行で説明してください。`
    );
    return out.text;
  },
});

const act = createStep({
  id: "act",
  input: Input,
  run: async ({ input }) => {
    const out = await agent.generate(
      `上の計画に基づき、依頼「${input.prompt}」のドラフトを短く作成してください。`
    );
    return out.text;
  },
});

const reflect = createStep({
  id: "reflect",
  input: Input,
  run: async ({ input }) => {
    const out = await agent.generate(
      `ドラフトを読み、明確さと簡潔さを高めて最終結果を返してください。依頼: ${input.prompt}`
    );
    return out.text;
  },
});

const workflow = createWorkflow({ id: "multi-step", input: Input })
  .then(plan)
  .then(act)
  .then(reflect)
  .commit();

// ---- SSE / CORS ヘルパー
const enc = new TextEncoder();
const sse = (event: string, data: any) =>
  enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const CORS = {
  "Access-Control-Allow-Origin": "*", // プロトタイプ向け。必要なら Bubble ドメインに限定
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export default async function handler(request: Request) {
  if (request.method !== "POST")
    return new Response("Method Not Allowed", { status: 405 });

  // 入力
  let prompt = "";
  try {
    const body = await request.json();
    prompt = body?.prompt ?? "";
  } catch {
    // 無入力でも動くようにする
    prompt = "";
  }

  // ストリームレスポンス
  const stream = new ReadableStream({
    async start(controller) {
      // まず Bubble に接続成功を伝える
      controller.enqueue(sse("ready", { ok: true }));

      try {
        const run = await workflow.createRunAsync();
        const raw = await run.stream({ inputData: { prompt } });

        // —— ここが重要 —— 
        // Mastra の .stream() はバージョンにより戻り値が違う
        // 1) { events: AsyncIterable } を返す版
        // 2) AsyncIterable を直接返す版
        // どちらでも動くようにフォールバック
        const iterable: AsyncIterable<any> =
          (raw as any)?.events ?? (raw as any);

        // 進捗を逐次送る（Bubble 側の「Returned Events」に出ます）
        for await (const evt of iterable) {
          controller.enqueue(sse("progress", evt));
        }

        // 完了結果（run.result は最終まとめ）
        const result = await run.result();
        controller.enqueue(sse("final", result));
      } catch (e: any) {
        controller.enqueue(
          sse("error", {
            message: e?.message || "unknown error",
            name: e?.name,
          })
        );
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
      ...CORS,
    },
  });
}
