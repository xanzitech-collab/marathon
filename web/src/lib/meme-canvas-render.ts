import { createCanvas, loadImage, type CanvasRenderingContext2D } from "canvas";

export interface MemeRenderInput {
  imageUrl: string;
  jokeText: string;
  style: "meme" | "tweet_screenshot";
  attempt?: number;
}

export interface RenderedMemeResult {
  ok: boolean;
  buffer?: Buffer;
  reason?: string;
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, lineHeight: number) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth) {
      if (current) {
        lines.push(current);
      }
      current = word;
    } else {
      current = test;
    }
  }

  if (current) lines.push(current);
  return lines;
}

export async function renderJokeOntoImage(input: MemeRenderInput): Promise<RenderedMemeResult> {
  try {
    const response = await fetch(input.imageUrl, { signal: AbortSignal.timeout(45_000) });
    if (!response.ok) {
      return { ok: false, reason: `fetch_failed:${response.status}` };
    }

    const arrayBuffer = await response.arrayBuffer();
    const image = await loadImage(Buffer.from(arrayBuffer));
    const width = image.width;
    const height = image.height;
    const canvas = createCanvas(width, Math.max(height + 220, height));
    const ctx = canvas.getContext("2d");
    const attempt = input.attempt ?? 1;
    const isRetry = attempt >= 2;

    ctx.drawImage(image, 0, 0, width, height);

    if (input.style === "tweet_screenshot") {
      const cardHeight = 180;
      const cardY = 0;
      ctx.fillStyle = isRetry ? "#f8fafc" : "#ffffff";
      ctx.fillRect(0, cardY, width, cardHeight);
      ctx.fillStyle = isRetry ? "#020617" : "#0f172a";
      ctx.font = `bold ${Math.max(26, Math.round(width / 22 * (isRetry ? 1.25 : 1)))}px sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      const lines = wrapText(ctx, input.jokeText, width - 60, 40).slice(0, 5);
      let y = 24;
      for (const line of lines) {
        ctx.fillText(line, 24, y);
        y += 38;
      }
      ctx.fillStyle = isRetry ? "#334155" : "#475569";
      ctx.font = `${Math.max(18, Math.round(width / 32 * (isRetry ? 1.25 : 1)))}px sans-serif`;
      ctx.fillText("@only1marathon", 24, y + 8);
    } else {
      const text = input.jokeText.slice(0, 80);
      const barHeight = 90;
      ctx.fillStyle = isRetry ? "rgba(0, 0, 0, 0.9)" : "rgba(0, 0, 0, 0.6)";
      ctx.fillRect(0, 0, width, barHeight);
      ctx.fillStyle = isRetry ? "#f8fafc" : "#ffffff";
      ctx.strokeStyle = isRetry ? "#020617" : "#000000";
      ctx.lineWidth = isRetry ? 10 : 8;
      ctx.font = `bold ${Math.max(28, Math.round(width / 18 * (isRetry ? 1.25 : 1)))}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const lines = wrapText(ctx, text, width - 60, 40).slice(0, 2);
      const centerY = barHeight / 2;
      for (const line of lines) {
        ctx.strokeText(line, width / 2, centerY);
        ctx.fillText(line, width / 2, centerY);
      }
    }

    return {
      ok: true,
      buffer: canvas.toBuffer("image/png"),
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "render_error",
    };
  }
}
