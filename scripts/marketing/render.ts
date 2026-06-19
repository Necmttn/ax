#!/usr/bin/env bun
/// <reference lib="dom" />
/**
 * ax marketing render harness.
 *
 * Turns a static HTML template into a SEAMLESS-LOOP mp4 (+ optional gif) or a
 * crisp static PNG. Drives animated backdrops deterministically via the render
 * contract (window.__t clock + window.__draw redraw) and scrubs CSS animations
 * frame-by-frame through the Web Animations API, so the output is reproducible
 * and loops with no visible cut.
 *
 * Usage:
 *   bun scripts/marketing/render.ts <template.html> [options]
 *
 * Options:
 *   --out=<path>     output file (default: <template>.mp4, or .png with --static)
 *   --fps=<n>        frames per second        (default 30)
 *   --loop=<ms>      loop duration in ms      (default 6000; keep all motion
 *                    periods dividing this for a seamless wrap)
 *   --scale=<n>      supersample factor       (default 2 → crisp downscale)
 *   --width=<n>      viewport width           (default 1280)
 *   --height=<n>     viewport height          (default 720)
 *   --gif            also emit a looping .gif next to the mp4
 *   --static         render a single PNG instead of a video
 *   --at=<ms>        timestamp for the static frame (default loop/2)
 *
 * Requires: playwright (repo dep) + ffmpeg on PATH.
 */
import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename, dirname } from "node:path";

interface Opts {
  html: string; out: string; fps: number; loop: number; scale: number;
  width: number; height: number; gif: boolean; static: boolean; at: number;
}

function parseArgs(argv: string[]): Opts {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      flags[k] = v ?? true;
    } else pos.push(a);
  }
  if (!pos[0]) {
    console.error("usage: bun scripts/marketing/render.ts <template.html> [--out= --fps= --loop= --scale= --gif --static --at=]");
    process.exit(1);
  }
  const html = resolve(pos[0]);
  const num = (k: string, d: number) => (flags[k] != null ? Number(flags[k]) : d);
  const isStatic = flags.static === true;
  const loop = num("loop", 6000);
  const defaultOut = html.replace(/\.html?$/i, isStatic ? ".png" : ".mp4");
  return {
    html,
    out: typeof flags.out === "string" ? resolve(flags.out) : defaultOut,
    fps: num("fps", 30),
    loop,
    scale: num("scale", 2),
    width: num("width", 1280),
    height: num("height", 720),
    gif: flags.gif === true,
    static: isStatic,
    at: num("at", Math.floor(loop / 2)),
  };
}

function ffmpeg(args: string[]) {
  const r = spawnSync("ffmpeg", ["-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
  if (r.status !== 0) {
    console.error(r.stderr?.toString().split("\n").slice(-8).join("\n"));
    throw new Error("ffmpeg failed");
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!existsSync(o.html)) { console.error(`not found: ${o.html}`); process.exit(1); }

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: o.width, height: o.height },
    deviceScaleFactor: o.scale,
  });
  // freeze the backdrop clock before any page script runs
  await page.addInitScript(() => { (window as unknown as { __t: number }).__t = 0; });
  await page.goto(`file://${o.html}`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);

  const setFrame = (t: number) =>
    page.evaluate((time) => {
      const w = window as unknown as { __t: number; __draw?: () => void };
      w.__t = time;
      if (w.__draw) w.__draw();
      for (const a of document.getAnimations()) a.currentTime = time;
    }, t);

  if (o.static) {
    await setFrame(o.at);
    await page.screenshot({ path: o.out });
    await browser.close();
    console.log(`▸ ${o.out}  (static @ ${o.at}ms)`);
    return;
  }

  await page.evaluate(() => { for (const a of document.getAnimations()) a.pause(); });

  const dir = mkdtempSync(join(tmpdir(), "ax-mkt-"));
  const step = 1000 / o.fps;
  const frames = Math.round(o.loop / step);
  for (let i = 0; i < frames; i++) {
    await setFrame(i * step);
    await page.screenshot({ path: join(dir, `f${String(i).padStart(4, "0")}.png`) });
  }
  await browser.close();

  const vf = `scale=${o.width}:${o.height}:flags=lanczos,format=yuv420p`;
  ffmpeg([
    "-framerate", String(o.fps), "-i", join(dir, "f%04d.png"),
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-vf", vf, "-c:v", "libx264", "-profile:v", "high", "-level", "4.0",
    "-crf", "19", "-preset", "slow", "-c:a", "aac", "-b:a", "96k",
    "-shortest", "-movflags", "+faststart", o.out,
  ]);
  console.log(`▸ ${o.out}  (${(o.loop / 1000).toFixed(1)}s loop, ${frames} frames @ ${o.fps}fps)`);

  if (o.gif) {
    const gifOut = o.out.replace(/\.mp4$/i, ".gif");
    const pal = join(dir, "pal.png");
    const gw = Math.round(o.width * 0.78), gh = Math.round(o.height * 0.78);
    ffmpeg(["-framerate", String(o.fps), "-i", join(dir, "f%04d.png"),
      "-vf", `fps=20,scale=${gw}:${gh}:flags=lanczos,palettegen=stats_mode=diff`, pal]);
    ffmpeg(["-framerate", String(o.fps), "-i", join(dir, "f%04d.png"), "-i", pal,
      "-lavfi", `fps=20,scale=${gw}:${gh}:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`,
      "-loop", "0", gifOut]);
    console.log(`▸ ${gifOut}  (looping fallback)`);
  }

  rmSync(dir, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
