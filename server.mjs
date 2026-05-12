// ════════════════════════════════════════════════════════════════════════════
//  Red Key — authoritative multiplayer game server
//  All physics, clash resolution, goal detection, and matchmaking run here.
//  Clients are pure renderers + input senders.
//
//  Run locally:    npm install && node server.mjs
//  Render/Railway: push this folder; start command = `node server.mjs`
//  Fly.io:         fly launch (uses package.json "start")
//  Glitch:         drag this folder into a new project
// ════════════════════════════════════════════════════════════════════════════

import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const PORT = parseInt(process.env.PORT || '3000', 10);
const TICK_MS = 16;                          // ~60 fps simulation tick

// ── Game constants (mirror of the client) ───────────────────────────────────
const F_LEFT = 10, F_RIGHT = 530, F_TOP = 10, F_BOT = 790;
const BALL_R = 9;
const PLAYER_R = 17;
const PICKUP_R = 24;
const BALL_OFFSET_MAG = 32;
const MAX_LEN = 190;
const DRIBBLE_PLAYER_MAX = 125;
const DRIBBLE_BALL_MAX   = 145;
const FRICTION = 0.965;
const BOUNCE   = 0.72;
const STOP_V   = 0.06;
const KICK_V0_MIN = 3.0;
const KICK_V0_MAX = 10.5;
const DRIBBLE_KICK_V0_MIN = 1.8;
const DRIBBLE_KICK_V0_MAX = 6.4;
const RUN_DUR = 720;
const CLASH_DIST = PLAYER_R * 2 + 4;
const GOAL_X_MIN = 215;
const GOAL_X_MAX = 325;
const QTE_ROUNDS = 3;
const SCORE_TARGET = 3;

const SLOT_MAP_US   = { forward: 'p10', leftWing: 'p11', rightWing: 'p7' };
const SLOT_MAP_THEM = { forward: 'p5',  leftWing: 'p4',  rightWing: 'p6'  };
const US_SLOTS   = ['p10', 'p11', 'p7'];
const THEM_SLOTS = ['p5',  'p4',  'p6'];
const SLOT_TO_TEAM = { p10:'us', p11:'us', p7:'us', p5:'them', p4:'them', p6:'them' };
const SLOT_TO_ROLE = { p10:'STRIKER', p11:'LEFT WING', p7:'RIGHT WING',
                       p5:'CB',       p4:'LEFT WING',  p6:'RIGHT WING' };

const START_POS = {
  p10: { x: 270, y: 540 },
  p11: { x: 130, y: 580 },
  p7:  { x: 410, y: 580 },
  p5:  { x: 270, y: 260 },
  p4:  { x: 130, y: 220 },
  p6:  { x: 410, y: 220 }
};
const START_BALL = { x: 270, y: 400 };

const statFactor = (stars) => (1 + (stars || 0) * 0.1) / 1.5;
const clamp      = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const hypot      = (x, y) => Math.sqrt(x * x + y * y);
const round1     = (n) => Math.round(n * 10) / 10;
const pairKey    = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`;

// ── Server-wide state ──────────────────────────────────────────────────────
const clientsByWs   = new Map();   // ws → { username, equipped, matchId }
const clientsByUser = new Map();   // username → ws
const queueList     = [];          // ws[]
const matches       = new Map();   // matchId → match
let nextMatchId = 1;

function send(ws, msg){
  if (ws && ws.readyState === 1){
    try { ws.send(JSON.stringify(msg)); } catch(_){}
  }
}
function broadcastMatch(match, msg){
  send(match.playerA.ws, msg);
  send(match.playerB.ws, msg);
}
function broadcastOnlineCount(){
  const count = clientsByUser.size;
  const msg = { type: 'online-count', count };
  for (const ws of clientsByWs.keys()) send(ws, msg);
}

// ── Match scaffolding ──────────────────────────────────────────────────────
function makePlayerSlot(slotId, equipped){
  const pos = START_POS[slotId];
  const team = SLOT_TO_TEAM[slotId];
  if (equipped){
    return {
      id: slotId, team, x: pos.x, y: pos.y,
      name: equipped.name || 'Substitute',
      num:  String(equipped.num != null ? equipped.num : 0),
      role: SLOT_TO_ROLE[slotId],
      stats: equipped.stats || { speed: 2, shooting: 2, stamina: 2 },
      rarity: equipped.rarity || 'common',
      weapons: (equipped.weapons || [null, null]).slice(0, 2),
      frozen: 0
    };
  }
  return {
    id: slotId, team, x: pos.x, y: pos.y,
    name: 'Substitute', num: '0',
    role: SLOT_TO_ROLE[slotId],
    stats: { speed: 2, shooting: 2, stamina: 2 },
    rarity: 'common', weapons: [null, null], frozen: 0
  };
}

function createMatch(wsA, wsB){
  const cA = clientsByWs.get(wsA);
  const cB = clientsByWs.get(wsB);
  if (!cA || !cB) return null;

  // Deterministic team assignment: lower username = 'us' (red, bottom).
  let usClient, themClient;
  if (cA.username < cB.username){ usClient = cA;  themClient = cB; }
  else                            { usClient = cB;  themClient = cA; }

  const id = String(nextMatchId++);
  const match = {
    id,
    playerA: { ws: usClient.ws,   username: usClient.username,   team: 'us',   equipped: usClient.equipped   || [null,null,null] },
    playerB: { ws: themClient.ws, username: themClient.username, team: 'them', equipped: themClient.equipped || [null,null,null] },
    players: {},
    ball: { x: START_BALL.x, y: START_BALL.y, rot: 0 },
    ballHolder: null,
    ballOffset: { x: 0, y: 0 },
    mode: 'kick',
    turn: 1,
    scoreUs: 0,
    scoreThem: 0,
    aimsA: null,                // us-team aims
    aimsB: null,                // them-team aims
    animating: false,
    runtime: null,
    clash: null,                // { ctx, scoresA, scoresB, resolved? }
  };

  // Stamp the six SVG slots with each side's equipped roster
  ['forward', 'leftWing', 'rightWing'].forEach((slot, i) => {
    match.players[SLOT_MAP_US[slot]]   = makePlayerSlot(SLOT_MAP_US[slot],   match.playerA.equipped[i]);
    match.players[SLOT_MAP_THEM[slot]] = makePlayerSlot(SLOT_MAP_THEM[slot], match.playerB.equipped[i]);
  });

  matches.set(id, match);
  cA.matchId = id;
  cB.matchId = id;

  // Notify each side
  send(match.playerA.ws, buildMatchStart(match, 'us'));
  send(match.playerB.ws, buildMatchStart(match, 'them'));
  return match;
}

function buildMatchStart(match, role){
  return {
    type: 'match-start',
    matchId: match.id,
    opponent: role === 'us' ? match.playerB.username : match.playerA.username,
    role,
    players: serializeAllPlayers(match),
    state: snapshotState(match),
    turn: match.turn,
    target: SCORE_TARGET,
    // Resume aids: true if this side has already submitted aims for this turn,
    // and whether the server is currently animating. The client uses these to
    // restore the local "locked-in" UI on a reconnect instead of letting the
    // user think they're between turns when they aren't.
    animating: !!match.animating,
    iLocked: role === 'us' ? !!match.aimsA : !!match.aimsB,
    oppLocked: role === 'us' ? !!match.aimsB : !!match.aimsA
  };
}
function serializeAllPlayers(match){
  const out = {};
  for (const id in match.players){
    const p = match.players[id];
    out[id] = {
      id: p.id, team: p.team, x: round1(p.x), y: round1(p.y),
      name: p.name, num: p.num, stats: p.stats,
      rarity: p.rarity, weapons: p.weapons
    };
  }
  return out;
}
function snapshotState(match){
  const ps = {};
  const frz = {};
  for (const id in match.players){
    ps[id]  = [round1(match.players[id].x), round1(match.players[id].y)];
    frz[id] = match.players[id].frozen | 0;
  }
  return {
    p: ps,
    b: [round1(match.ball.x), round1(match.ball.y)],
    r: Math.round(match.ball.rot) | 0,
    h: match.ballHolder,
    m: match.mode,
    f: frz,
    s: [match.scoreUs, match.scoreThem],
    t: match.turn
  };
}

// ── Per-player stat factors ────────────────────────────────────────────────
const speedFactor    = (m, id) => statFactor(m.players[id].stats.speed);
const staminaFactor  = (m, id) => statFactor(m.players[id].stats.stamina);
const shootingFactor = (m, id) => statFactor(m.players[id].stats.shooting);

// ── Ball physics ───────────────────────────────────────────────────────────
function buildPickupCandidates(match, excludeId){
  const out = [];
  for (const id in match.players){
    if (id === excludeId) continue;
    if (match.players[id].frozen > 0) continue;
    out.push({ id, x: match.players[id].x, y: match.players[id].y });
  }
  return out;
}
function ballStep(state, candidates){
  state.x += state.vx;
  state.y += state.vy;
  let bounced = false;
  if (state.x < state.minX){ state.x = state.minX + (state.minX - state.x); state.vx = -state.vx * BOUNCE; bounced = true; }
  else if (state.x > state.maxX){ state.x = state.maxX - (state.x - state.maxX); state.vx = -state.vx * BOUNCE; bounced = true; }
  if (state.y < state.minY && state.x >= GOAL_X_MIN && state.x <= GOAL_X_MAX){
    state.vx = 0; state.vy = 0;
    return { bounced, pickedUp: false, holderId: null, goal: 'us' };
  }
  if (state.y > state.maxY && state.x >= GOAL_X_MIN && state.x <= GOAL_X_MAX){
    state.vx = 0; state.vy = 0;
    return { bounced, pickedUp: false, holderId: null, goal: 'them' };
  }
  if (state.y < state.minY){ state.y = state.minY + (state.minY - state.y); state.vy = -state.vy * BOUNCE; bounced = true; }
  else if (state.y > state.maxY){ state.y = state.maxY - (state.y - state.maxY); state.vy = -state.vy * BOUNCE; bounced = true; }
  for (const cand of candidates){
    const dx = state.x - cand.x, dy = state.y - cand.y;
    const dist = hypot(dx, dy);
    const minD = BALL_R + PLAYER_R;
    if (dist < minD){
      const nx = dist > 0.01 ? dx/dist : 1;
      const ny = dist > 0.01 ? dy/dist : 0;
      state.x = cand.x + nx * BALL_OFFSET_MAG;
      state.y = cand.y + ny * BALL_OFFSET_MAG;
      state.vx = 0; state.vy = 0;
      state.pickupOffset = { x: nx * BALL_OFFSET_MAG, y: ny * BALL_OFFSET_MAG };
      return { bounced, pickedUp: true, holderId: cand.id };
    }
  }
  state.vx *= FRICTION;
  state.vy *= FRICTION;
  return { bounced, pickedUp: false, holderId: null };
}

// ── Runtime build (called when both aims arrived) ──────────────────────────
function buildRuntime(match){
  const aimsA = match.aimsA || {};
  const aimsB = match.aimsB || {};
  const allAims = {};
  for (const id of US_SLOTS)   allAims[id] = (aimsA.aims || {})[id] || null;
  for (const id of THEM_SLOTS) allAims[id] = (aimsB.aims || {})[id] || null;

  // Ball action
  let ballAction = null, kickerId = null;
  if (match.ballHolder){
    const team = SLOT_TO_TEAM[match.ballHolder];
    const holderAims = team === 'us' ? aimsA : aimsB;
    if (holderAims && holderAims.ballAim){
      if (holderAims.mode === 'kick'){
        ballAction = { type: 'kick', aim: holderAims.ballAim };
        kickerId = match.ballHolder;
      } else if (holderAims.mode === 'dribble' && allAims[match.ballHolder]){
        ballAction = { type: 'dribble', aim: holderAims.ballAim };
        kickerId = match.ballHolder;
      }
    }
  }

  const runs = [];
  for (const id in match.players){
    if (match.players[id].frozen > 0) continue;
    if (id === match.ballHolder && ballAction && ballAction.type === 'kick') continue; // holder stands during kick
    if (allAims[id]){
      runs.push({
        moverId: id,
        startPos: { x: match.players[id].x, y: match.players[id].y },
        endPos:   { x: allAims[id].x, y: allAims[id].y }
      });
    }
  }

  let ballState = null;
  if (ballAction){
    const dx = ballAction.aim.x - match.ball.x;
    const dy = ballAction.aim.y - match.ball.y;
    const len = hypot(dx, dy) || 1;
    const shoot = shootingFactor(match, kickerId);
    let speed;
    if (ballAction.type === 'kick'){
      const power = Math.min(1, len / MAX_LEN);
      speed = (KICK_V0_MIN + power * (KICK_V0_MAX - KICK_V0_MIN)) * shoot;
    } else {
      const power = Math.min(1, len / DRIBBLE_BALL_MAX);
      speed = (DRIBBLE_KICK_V0_MIN + power * (DRIBBLE_KICK_V0_MAX - DRIBBLE_KICK_V0_MIN)) * shoot;
    }
    ballState = {
      x: match.ball.x, y: match.ball.y,
      vx: (dx / len) * speed,
      vy: (dy / len) * speed,
      minX: F_LEFT + BALL_R, maxX: F_RIGHT - BALL_R,
      minY: F_TOP + BALL_R,  maxY: F_BOT - BALL_R,
      moving: true,
      pickupOffset: null
    };
    match.ballHolder = null;
    match.ballOffset = { x: 0, y: 0 };
  }

  return {
    runs, ballState, kickerId,
    bounces: 0,
    firstResolverId: null,
    t0: Date.now(),
    pauseDuration: 0,
    pauseStartedAt: 0,
    clashQueue: [],
    activeClashIds: new Set(),
    resolvedPairs: new Set()
  };
}

function startTurnAnimation(match){
  match.animating = true;
  match.runtime = buildRuntime(match);
  match.aimsA = null;
  match.aimsB = null;
}

// ── Tick the simulation for one match ──────────────────────────────────────
function tickMatch(match){
  if (!match.animating) return;
  if (match.clash) return; // QTE owns the floor

  const r = match.runtime;
  if (!r) return;

  const now = Date.now();
  if (r.clashQueue.length > 0){
    r.pauseStartedAt = now;
    const ctx = r.clashQueue.shift();
    match.clash = { ctx, scoresA: [], scoresB: [], resolved: null };
    broadcastMatch(match, { type: 'clash-start', ctx });
    return;
  }

  const elapsed = now - r.t0 - r.pauseDuration;

  // Update mover positions (skip clashing players — they freeze at impact)
  let allRunsDone = true;
  for (const run of r.runs){
    if (r.activeClashIds.has(run.moverId)){ allRunsDone = false; continue; }
    const dur = RUN_DUR / Math.max(0.1, speedFactor(match, run.moverId));
    const k = Math.min(1, elapsed / dur);
    const ek = 1 - Math.pow(1 - k, 3);
    const p = match.players[run.moverId];
    p.x = run.startPos.x + (run.endPos.x - run.startPos.x) * ek;
    p.y = run.startPos.y + (run.endPos.y - run.startPos.y) * ek;
    if (k < 1) allRunsDone = false;
  }

  // Clash detection (pairwise, opposite-team only)
  for (const run of r.runs){
    const mover = match.players[run.moverId];
    if (r.activeClashIds.has(mover.id)) continue;
    if (mover.frozen > 0) continue;
    for (const id in match.players){
      if (id === mover.id) continue;
      const other = match.players[id];
      if (other.team === mover.team) continue;
      if (other.frozen > 0) continue;
      if (r.activeClashIds.has(id)) continue;
      const key = pairKey(mover.id, id);
      if (r.resolvedPairs.has(key)) continue;
      const dx = mover.x - other.x, dy = mover.y - other.y;
      if (hypot(dx, dy) < CLASH_DIST){
        r.activeClashIds.add(mover.id);
        r.activeClashIds.add(id);
        r.resolvedPairs.add(key);
        r.clashQueue.push({ moverId: mover.id, opponentId: id });
      }
    }
  }
  if (r.clashQueue.length > 0) return; // drain on next tick

  // Step ball
  let ballDone = !r.ballState || !r.ballState.moving;
  let goalScored = null;
  if (r.ballState && r.ballState.moving){
    const exclude = elapsed < 220 ? r.kickerId : null;
    const cands = buildPickupCandidates(match, exclude);
    const result = ballStep(r.ballState, cands);
    if (result.bounced) r.bounces += 1;
    const sp = hypot(r.ballState.vx, r.ballState.vy);
    match.ball.rot += sp * 6;
    match.ball.x = r.ballState.x;
    match.ball.y = r.ballState.y;
    if (result.goal){
      r.ballState.moving = false;
      goalScored = result.goal;
      ballDone = true;
    } else if (result.pickedUp){
      r.ballState.moving = false;
      match.ballHolder = result.holderId;
      match.ballOffset = r.ballState.pickupOffset;
      r.firstResolverId = result.holderId;
      match.mode = 'kick';
      ballDone = true;
    } else if (sp <= STOP_V){
      r.ballState.moving = false;
      ballDone = true;
    }
  }

  // Loose-ball pickup by a mover (no kick this turn)
  if (!r.ballState && match.ballHolder === null){
    for (const run of r.runs){
      if (r.activeClashIds.has(run.moverId)) continue;
      const p = match.players[run.moverId];
      const dx = match.ball.x - p.x, dy = match.ball.y - p.y;
      if (hypot(dx, dy) < PICKUP_R){
        const dirX = run.endPos.x - run.startPos.x;
        const dirY = run.endPos.y - run.startPos.y;
        const dl = hypot(dirX, dirY) || 1;
        match.ballOffset = { x: (dirX/dl)*BALL_OFFSET_MAG, y: (dirY/dl)*BALL_OFFSET_MAG };
        match.ballHolder = run.moverId;
        r.firstResolverId = run.moverId;
        match.ball.x = p.x + match.ballOffset.x;
        match.ball.y = p.y + match.ballOffset.y;
        match.mode = 'kick';
        break;
      }
    }
  }

  // Ball follows a running holder
  if (match.ballHolder !== null){
    const h = match.players[match.ballHolder];
    if (r.runs.some(run => run.moverId === match.ballHolder && !r.activeClashIds.has(run.moverId))){
      match.ball.x = h.x + match.ballOffset.x;
      match.ball.y = h.y + match.ballOffset.y;
      match.ball.rot += 1.5;
    }
  }

  // Stream the new state out
  broadcastMatch(match, { type: 'turn-state', state: snapshotState(match) });

  if (goalScored){
    handleGoalServer(match, goalScored);
    return;
  }

  const noClashesPending = r.clashQueue.length === 0 && r.activeClashIds.size === 0;
  if (allRunsDone && ballDone && noClashesPending){
    // Snap final positions
    for (const run of r.runs){
      match.players[run.moverId].x = run.endPos.x;
      match.players[run.moverId].y = run.endPos.y;
    }
    endTurnServer(match);
  }
}

// ── Turn end / goal / kickoff ──────────────────────────────────────────────
function endTurnServer(match){
  for (const id in match.players){
    if (match.players[id].frozen > 0) match.players[id].frozen -= 1;
  }
  match.turn += 1;
  match.animating = false;
  match.runtime = null;
  broadcastMatch(match, {
    type: 'turn-end',
    state: snapshotState(match),
    turn: match.turn
  });
}

function handleGoalServer(match, side){
  if (side === 'us') match.scoreUs += 1;
  else               match.scoreThem += 1;
  broadcastMatch(match, {
    type: 'goal',
    side,
    scoreUs: match.scoreUs,
    scoreThem: match.scoreThem
  });
  if (match.scoreUs >= SCORE_TARGET || match.scoreThem >= SCORE_TARGET){
    finishMatch(match);
    return;
  }
  // Brief celebration, then kick off
  match.animating = false;
  match.runtime = null;
  setTimeout(() => {
    if (!matches.has(match.id)) return;
    resetAfterGoalServer(match, side);
  }, 1300);
}

function resetAfterGoalServer(match, scoringSide){
  for (const id in match.players){
    const sp = START_POS[id];
    match.players[id].x = sp.x;
    match.players[id].y = sp.y;
    match.players[id].frozen = 0;
  }
  match.ball.rot = 0;
  match.mode = 'kick';

  // The team that was scored on receives the kickoff
  if (scoringSide === 'us'){
    match.ballHolder = 'p5';
    match.ballOffset = { x: 0, y: BALL_OFFSET_MAG };
  } else {
    match.ballHolder = 'p10';
    match.ballOffset = { x: 0, y: -BALL_OFFSET_MAG };
  }
  const h = match.players[match.ballHolder];
  match.ball.x = h.x + match.ballOffset.x;
  match.ball.y = h.y + match.ballOffset.y;
  match.turn += 1;
  match.runtime = null;
  match.animating = false;
  match.clash = null;

  broadcastMatch(match, {
    type: 'kickoff',
    side: scoringSide,
    state: snapshotState(match)
  });
}

// ── Clash QTE ──────────────────────────────────────────────────────────────
function handleQteScore(ws, msg){
  const c = clientsByWs.get(ws);
  if (!c || !c.matchId) return;
  const match = matches.get(c.matchId);
  if (!match || !match.clash) return;
  const isUs = c.username === match.playerA.username; // 'us' team
  const arr = isUs ? match.clash.scoresA : match.clash.scoresB;
  arr[msg.round - 1] = msg.score;

  // Notify the opponent for live total updates
  const oppWs = isUs ? match.playerB.ws : match.playerA.ws;
  send(oppWs, { type: 'opp-qte-score', round: msg.round, score: msg.score });

  const aDone = match.clash.scoresA.filter(s => s != null).length >= QTE_ROUNDS;
  const bDone = match.clash.scoresB.filter(s => s != null).length >= QTE_ROUNDS;
  if (aDone && bDone && !match.clash.resolved){
    resolveClashServer(match);
  }
}
function resolveClashServer(match){
  const totalA = match.clash.scoresA.reduce((a,b)=>a+b, 0);
  const totalB = match.clash.scoresB.reduce((a,b)=>a+b, 0);
  const ctx = match.clash.ctx;
  const moverTeam = SLOT_TO_TEAM[ctx.moverId];
  const totalMover = moverTeam === 'us' ? totalA : totalB;
  const totalOpp   = moverTeam === 'us' ? totalB : totalA;
  let winnerId, loserId;
  if (totalMover > totalOpp){ winnerId = ctx.moverId;    loserId = ctx.opponentId; }
  else if (totalOpp > totalMover){ winnerId = ctx.opponentId; loserId = ctx.moverId; }
  else { winnerId = ctx.moverId; loserId = ctx.opponentId; } // tie → mover wins
  const throwAngle = Math.random() * Math.PI * 2;
  const throwDist  = 55 + Math.random() * 30;
  const outcome = { winnerId, loserId, throwAngle, throwDist,
                    totalA, totalB };
  match.clash.resolved = outcome;
  broadcastMatch(match, { type: 'clash-outcome', outcome });
}
function handleClashDismiss(ws){
  const c = clientsByWs.get(ws);
  if (!c || !c.matchId) return;
  const match = matches.get(c.matchId);
  if (!match || !match.clash || !match.clash.resolved) return;
  applyClashOutcomeServer(match, match.clash.resolved);
  // Resume sim (account for pause time)
  if (match.runtime){
    if (match.runtime.pauseStartedAt > 0){
      match.runtime.pauseDuration += Date.now() - match.runtime.pauseStartedAt;
      match.runtime.pauseStartedAt = 0;
    }
  }
  match.clash = null;
  broadcastMatch(match, { type: 'clash-dismiss' });
  broadcastMatch(match, { type: 'turn-state', state: snapshotState(match) });
}
function applyClashOutcomeServer(match, outcome){
  const { winnerId, loserId, throwAngle, throwDist } = outcome;
  const loser = match.players[loserId];
  let nx = loser.x + Math.cos(throwAngle) * throwDist;
  let ny = loser.y + Math.sin(throwAngle) * throwDist;
  nx = clamp(nx, F_LEFT + PLAYER_R + 1, F_RIGHT - PLAYER_R - 1);
  ny = clamp(ny, F_TOP  + PLAYER_R + 1, F_BOT   - PLAYER_R - 1);
  loser.x = nx; loser.y = ny; loser.frozen = 2;

  if (match.ballHolder === loserId){
    match.ballHolder = winnerId;
    const w = match.players[winnerId];
    const dirY = w.team === 'us' ? -BALL_OFFSET_MAG : BALL_OFFSET_MAG;
    match.ballOffset = { x: 0, y: dirY };
    match.ball.x = w.x + match.ballOffset.x;
    match.ball.y = w.y + match.ballOffset.y;
    match.mode = 'kick';
  }
  if (match.runtime){
    match.runtime.runs = match.runtime.runs.filter(r => r.moverId !== loserId);
    match.runtime.activeClashIds.delete(winnerId);
    match.runtime.activeClashIds.delete(loserId);
  }
}

// ── Finish + cleanup ───────────────────────────────────────────────────────
function finishMatch(match){
  const usWon = match.scoreUs >= SCORE_TARGET;
  const aWon = match.playerA.team === 'us' ? usWon : !usWon;
  const bWon = match.playerB.team === 'us' ? usWon : !usWon;
  send(match.playerA.ws, { type: 'match-end', won: aWon, keys: aWon ? 200 : 25,
                            scoreUs: match.scoreUs, scoreThem: match.scoreThem });
  send(match.playerB.ws, { type: 'match-end', won: bWon, keys: bWon ? 200 : 25,
                            scoreUs: match.scoreUs, scoreThem: match.scoreThem });
  cleanupMatch(match);
}
function cleanupMatch(match){
  matches.delete(match.id);
  const cA = clientsByWs.get(match.playerA.ws);
  const cB = clientsByWs.get(match.playerB.ws);
  if (cA) cA.matchId = null;
  if (cB) cB.matchId = null;
}

// ── Matchmaking ─────────────────────────────────────────────────────────────
function tryPair(){
  while (queueList.length >= 2){
    const wsA = queueList.shift();
    const wsB = queueList.shift();
    if (!wsA || wsA.readyState !== 1){ if (wsB && wsB.readyState === 1) queueList.unshift(wsB); continue; }
    if (!wsB || wsB.readyState !== 1){ continue; }
    const cA = clientsByWs.get(wsA);
    const cB = clientsByWs.get(wsB);
    if (!cA || !cB) continue;
    if (cA.matchId || cB.matchId) continue;
    createMatch(wsA, wsB);
  }
}

// ── Tick loop (one server-wide interval drives all matches) ────────────────
setInterval(() => {
  for (const match of matches.values()){
    if (match.animating) tickMatch(match);
  }
}, TICK_MS);

// ── Message router ─────────────────────────────────────────────────────────
function handleMessage(ws, msg){
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
  const c = clientsByWs.get(ws);

  switch (msg.type){
    case 'hello': {
      const u = (msg.username || '').trim();
      if (!u){ send(ws, { type: 'error', message: 'username required' }); return; }

      // Resume any in-progress match this user has. Look up via prior session
      // first, then fall back to scanning matches (handles fresh-tab reconnect
      // after the prior session was already cleaned up).
      const prior = clientsByUser.get(u);
      const priorInfo = (prior && prior !== ws) ? clientsByWs.get(prior) : null;
      let resumeMatch = (priorInfo && priorInfo.matchId) ? matches.get(priorInfo.matchId) : null;
      if (!resumeMatch){
        for (const m of matches.values()){
          if (m.playerA.username === u || m.playerB.username === u){ resumeMatch = m; break; }
        }
      }
      // Transfer the WS reference inside the match BEFORE we clean up the old
      // socket so handleDisconnect for the old WS sees stale bookkeeping and bails.
      if (resumeMatch){
        if (resumeMatch.playerA.username === u) resumeMatch.playerA.ws = ws;
        if (resumeMatch.playerB.username === u) resumeMatch.playerB.ws = ws;
      }
      if (prior && prior !== ws){
        clientsByWs.delete(prior);
        try { prior.close(4001, 'session-replaced'); } catch(_){}
      }

      const info = {
        ws,
        username: u,
        equipped: msg.equipped || [null,null,null],
        matchId: resumeMatch ? resumeMatch.id : null
      };
      clientsByWs.set(ws, info);
      clientsByUser.set(u, ws);
      send(ws, { type: 'welcome', username: u, onlineCount: clientsByUser.size });
      broadcastOnlineCount();

      // Push current match state to the resumed tab so it can pick up exactly
      // where the player left off.
      if (resumeMatch){
        const role = resumeMatch.playerA.username === u ? 'us' : 'them';
        send(ws, buildMatchStart(resumeMatch, role));
        // Let the opponent know their partner is back (if they're connected).
        const oppWs = role === 'us' ? resumeMatch.playerB.ws : resumeMatch.playerA.ws;
        if (oppWs && oppWs !== ws) send(oppWs, { type: 'opponent-reconnected', username: u });
      }
      break;
    }
    case 'roster': {
      if (c) c.equipped = msg.equipped || [null,null,null];
      break;
    }
    case 'queue': {
      if (!c) break;
      if (c.matchId) break;
      if (!queueList.includes(ws)) queueList.push(ws);
      send(ws, { type: 'queued' });
      tryPair();
      break;
    }
    case 'cancel-queue': {
      const idx = queueList.indexOf(ws);
      if (idx >= 0) queueList.splice(idx, 1);
      send(ws, { type: 'queue-cancelled' });
      break;
    }
    case 'invite': {
      if (!c) break;
      const target = clientsByUser.get(msg.to);
      if (!target){ send(ws, { type: 'error', message: `User "${msg.to}" isn't online.` }); break; }
      const targetInfo = clientsByWs.get(target);
      if (targetInfo && targetInfo.matchId){ send(ws, { type: 'error', message: `${msg.to} is already in a match.` }); break; }
      send(target, { type: 'incoming-invite', from: c.username });
      break;
    }
    case 'invite-accept': {
      if (!c) break;
      const target = clientsByUser.get(msg.from);
      if (!target) break;
      const targetInfo = clientsByWs.get(target);
      if (targetInfo && targetInfo.matchId) break;
      if (c.matchId) break;
      createMatch(ws, target);
      break;
    }
    case 'invite-decline': {
      if (!c) break;
      const target = clientsByUser.get(msg.from);
      if (target) send(target, { type: 'invite-declined', from: c.username });
      break;
    }
    case 'aims': {
      if (!c || !c.matchId) break;
      const match = matches.get(c.matchId);
      if (!match || match.animating) break;
      const slot = c.username === match.playerA.username ? 'aimsA' : 'aimsB';
      match[slot] = { aims: msg.aims || {}, ballAim: msg.ballAim || null, mode: msg.mode || 'kick' };
      // Tell the other side
      const oppWs = c.username === match.playerA.username ? match.playerB.ws : match.playerA.ws;
      send(oppWs, { type: 'opponent-locked' });
      if (match.aimsA && match.aimsB){
        startTurnAnimation(match);
      }
      break;
    }
    case 'qte-score':   handleQteScore(ws, msg);   break;
    case 'clash-dismiss': handleClashDismiss(ws); break;
    case 'match-quit': {
      if (!c || !c.matchId) break;
      const match = matches.get(c.matchId);
      if (!match) break;
      const oppWs = c.username === match.playerA.username ? match.playerB.ws : match.playerA.ws;
      send(ws,    { type: 'match-end', won: false, keys: 0, scoreUs: match.scoreUs, scoreThem: match.scoreThem });
      send(oppWs, { type: 'match-end', won: true,  keys: 200, scoreUs: match.scoreUs, scoreThem: match.scoreThem });
      cleanupMatch(match);
      break;
    }
  }
}

function handleDisconnect(ws){
  const c = clientsByWs.get(ws);
  if (!c) return;
  // Match persists across disconnects — it only ends on quit or win. We just
  // null out the WS reference so subsequent broadcasts to the missing side
  // become no-ops. The player can resume by opening another tab and the
  // server will transfer the match into their new WS via the `hello` handler.
  if (c.matchId){
    const match = matches.get(c.matchId);
    if (match){
      if (match.playerA.username === c.username) match.playerA.ws = null;
      if (match.playerB.username === c.username) match.playerB.ws = null;
      const oppWs = c.username === match.playerA.username ? match.playerB.ws : match.playerA.ws;
      if (oppWs) send(oppWs, { type: 'opponent-disconnected', username: c.username });
    }
  }
  const qi = queueList.indexOf(ws);
  if (qi >= 0) queueList.splice(qi, 1);
  clientsByWs.delete(ws);
  if (clientsByUser.get(c.username) === ws) clientsByUser.delete(c.username);
  broadcastOnlineCount();
}

// ── Boot ───────────────────────────────────────────────────────────────────
// Find red-key.html so we can serve it on GET /. We check a few likely paths
// so it works whether server.mjs is run alongside the HTML or one folder down.
async function loadHtml(){
  const candidates = [
    join(__dirname, 'red-key.html'),
    join(__dirname, '..', 'red-key.html'),
    join(process.cwd(), 'red-key.html'),
  ];
  for (const p of candidates){
    try {
      const content = await readFile(p, 'utf8');
      console.log(`Serving HTML from ${p}`);
      return content;
    } catch(_){}
  }
  console.warn(`red-key.html not found — only the WebSocket endpoint will work.`);
  return null;
}
const PLACEHOLDER_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Red Key</title>
<style>body{background:#07070a;color:#f5f5f7;font-family:sans-serif;display:flex;
align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;
text-align:center}h1{color:#ef2b3a}</style></head><body><div>
<h1>Red Key</h1><p>Game server is running but red-key.html isn't in this folder.</p>
<p>Drop <code>red-key.html</code> next to <code>server.mjs</code>, then refresh.</p>
</div></body></html>`;

let cachedHtml = null;
const htmlReady = loadHtml().then((html) => { cachedHtml = html; });

const httpServer = createServer(async (req, res) => {
  // Tiny health endpoint — useful for cloud uptime pings
  if (req.method === 'GET' && req.url === '/health'){
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  // Serve the HTML (or a friendly placeholder) on the root + a few aliases
  if (req.method === 'GET' && (req.url === '/' || req.url === '/red-key.html' || req.url === '/index.html')){
    await htmlReady;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(cachedHtml || PLACEHOLDER_HTML);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    try { handleMessage(ws, JSON.parse(data.toString())); } catch(_){}
  });
  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => {});
});

httpServer.listen(PORT, () => {
  console.log(`Red Key server ready: http://localhost:${PORT}/`);
});
