// Drive the real page in headless Chrome via CDP (built-in WebSocket/fetch, no deps).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9000 + Math.floor((Date.now() % 900));
const PROFILE = mkdtempSync(join(tmpdir(), 'vr-cdp-'));
const url = 'file://' + join(process.cwd(), 'index.html');

const chrome = spawn('google-chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--window-size=900,600', url,
], { stdio: 'ignore' });

function cleanup(code) {
  try { chrome.kill('SIGKILL'); } catch {}
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  process.exit(code);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      const list = await r.json();
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(120);
  }
  throw new Error('no devtools target');
}

async function main() {
  const wsUrl = await getWsUrl();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise(res => {
    const mid = ++id; pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evalJS = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  // wait for the game hook
  for (let i = 0; i < 50; i++) {
    if (await evalJS('!!(window.__game)')) break;
    await sleep(100);
  }
  if (!await evalJS('!!(window.__game)')) throw new Error('__game hook missing');
  await evalJS('window.__game.pause();');  // harness fully owns stepping (deterministic)

  const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
  const level = await evalJS('window.__game.LEVEL');

  // helper to run N deterministic steps and read ball
  const steps = n => evalJS(`(()=>{for(let i=0;i<${n};i++)window.__game.step();const b=window.__game.state.ball;return{x:b.x,y:b.y,vx:b.vx,vy:b.vy,res:window.__game.state.result};})()`);

  const results = [];

  // ---- Test 1: without any dent, is the ball genuinely inert & unsteerable? --
  // (a) over a realistic round (~1200 steps ≈ 20s) it barely moves;
  // (b) over a very long horizon (12000 steps ≈ 3.3min) it NEVER self-solves —
  //     it just relaxes into the nearest local dip and stops.
  await evalJS('window.__game.reset(); window.__game.release();');
  let sRound = await steps(1200);
  const driftRound = dist(sRound.x, sRound.y, level.ballStart.x, level.ballStart.y);
  results.push(['no-dent drift over a round (1200 steps)', driftRound.toFixed(1) + 'px', driftRound < 12]);
  let s = await steps(12000 - 1200);
  results.push(['no-dent: never self-solves (12000 steps)', s.res || 'none', s.res === null]);

  // ---- Test 2: can a reasonable dent policy guide it to the target? ----
  // Policy: press toward the target while far; ease off (release) as it nears so
  // it coasts and settles without overshooting into the pit.
  await evalJS('window.__game.reset();');
  let won = false, lost = false, frames = 0;
  const t = level.target, f = level.falsePit;
  for (let i = 0; i < 900 && !won && !lost; i++) {
    // read ball
    const b = await evalJS('(()=>{const b=window.__game.state.ball;return{x:b.x,y:b.y,vx:b.vx,vy:b.vy,res:window.__game.state.result};})()');
    frames = i;
    if (b.res === 'win') { won = true; break; }
    if (b.res === 'lose') { lost = true; break; }
    const dT = dist(b.x, b.y, t.x, t.y);
    const speed = Math.hypot(b.vx, b.vy);
    // aim a bit "short" of the target so momentum carries the rest; release near it
    if (dT > 130) {
      // pull from just beyond the ball toward target: place cursor between ball and target
      const ux = (t.x - b.x) / dT, uy = (t.y - b.y) / dT;
      await evalJS(`window.__game.press(${b.x + ux*90}, ${b.y + uy*90});`);
    } else if (dT > 55 && speed < 1.2) {
      // nudge gently if stalling short
      const ux = (t.x - b.x) / dT, uy = (t.y - b.y) / dT;
      await evalJS(`window.__game.press(${b.x + ux*60}, ${b.y + uy*60});`);
    } else {
      await evalJS('window.__game.release();');
    }
    await steps(4);
  }
  results.push(['dent policy reaches target (win)', won ? 'win@' + frames : (lost ? 'LOST' : 'timeout'), won]);

  // ---- Test 3: the pit is a real hazard — a straight over-pull falls in ----
  await evalJS('window.__game.reset();');
  let fell = false;
  for (let i = 0; i < 900 && !fell; i++) {
    const b = await evalJS('(()=>{const b=window.__game.state.ball;return{x:b.x,y:b.y,res:window.__game.state.result};})()');
    if (b.res === 'lose') { fell = true; break; }
    if (b.res === 'win') break;
    // careless player: keep dragging the dent toward the far pit (past the target),
    // never easing off — should overshoot the goal and get sucked into the decoy.
    const d = dist(b.x, b.y, f.x, f.y) || 1;
    const ux = (f.x - b.x) / d, uy = (f.y - b.y) / d;
    await evalJS(`window.__game.press(${b.x + ux*90}, ${b.y + uy*90});`);
    await steps(4);
  }
  results.push(['pit is reachable / real hazard', fell ? 'fell in' : 'not reached', fell]);

  console.log('\n=== valley-roll verification ===');
  let ok = true;
  for (const [name, val, pass] of results) {
    if (!pass) ok = false;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: ${val}`);
  }
  console.log(ok ? '\nALL PASS' : '\nSOME FAILED');
  cleanup(ok ? 0 : 1);
}

main().catch(e => { console.error('ERR', e); cleanup(2); });
