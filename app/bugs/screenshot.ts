import { LIMITS } from "../../src/bug-schema.ts";

/**
 * Screenshots for a bug report, two ways:
 *
 *  - drawn: the app re-draws its own page into an image (modern-screenshot)
 *    the moment the button is pressed — no prompt, works everywhere, close
 *    to what was on screen though some styling can come out slightly off;
 *  - captured: the browser's own screen capture (getDisplayMedia) — exact,
 *    but the browser asks each time, and phones don't offer it.
 */

export interface Shot {
  kind: "drawn" | "captured";
  mime: "image/webp" | "image/png" | "image/jpeg";
  width: number;
  height: number;
  /** Base64, no data: prefix. */
  data: string;
  /** For showing it in the dialog. */
  url: string;
}

async function toShot(kind: Shot["kind"], canvas: HTMLCanvasElement): Promise<Shot> {
  // WebP where the browser encodes it (Safari may hand back PNG instead);
  // smaller JPEG if it's still too big.
  const attempts: [Shot["mime"], number, number][] = [
    ["image/webp", 0.85, 1],
    ["image/jpeg", 0.75, 1],
    ["image/jpeg", 0.6, 0.5],
  ];
  for (const [type, quality, scale] of attempts) {
    let source = canvas;
    if (scale !== 1) {
      source = document.createElement("canvas");
      source.width = Math.round(canvas.width * scale);
      source.height = Math.round(canvas.height * scale);
      source.getContext("2d")!.drawImage(canvas, 0, 0, source.width, source.height);
    }
    const blob = await new Promise<Blob | null>((resolve) => source.toBlob(resolve, type, quality));
    if (!blob || blob.size > LIMITS.imageBytes) continue;
    const mime = (["image/webp", "image/png", "image/jpeg"] as const).find((m) => m === blob.type) ?? "image/png";
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
      reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the image"));
      reader.readAsDataURL(blob);
    });
    return { kind, mime, width: source.width, height: source.height, data, url: URL.createObjectURL(blob) };
  }
  throw new Error("The screenshot came out too large to send.");
}

/**
 * The visible part of the page, as drawn by the app. Elements marked
 * `data-bug-exclude` are left out (the report button itself, toasts).
 */
export async function drawPage(timeoutMs = 8000): Promise<Shot> {
  const { domToCanvas } = await import("modern-screenshot");
  const drawing = domToCanvas(document.documentElement, {
    width: innerWidth,
    height: innerHeight,
    // The viewport, not the whole document: what the person was looking at.
    style: { transform: `translate(${-scrollX}px, ${-scrollY}px)` },
    scale: Math.min(devicePixelRatio || 1, 2),
    backgroundColor: getComputedStyle(document.body).backgroundColor || "#ffffff",
    filter: (node) => !(node instanceof Element && node.hasAttribute("data-bug-exclude")),
    timeout: timeoutMs,
  });
  const canvas = await Promise.race([
    drawing,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Drawing the page took too long.")), timeoutMs)),
  ]);
  return toShot("drawn", canvas);
}

/** Whether this browser can capture the real screen. */
export function canCapture(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function";
}

/** One frame of what the person picks to share (this tab is offered first). */
export async function captureScreen(): Promise<Shot> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "browser" },
    audio: false,
    // Chrome: offer this tab, first.
    ...({ preferCurrentTab: true, selfBrowserSurface: "include" } as object),
  } as DisplayMediaStreamOptions);
  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    // A frame or two for the first image to arrive.
    await new Promise((r) => setTimeout(r, 300));
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    video.pause();
    return await toShot("captured", canvas);
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}
