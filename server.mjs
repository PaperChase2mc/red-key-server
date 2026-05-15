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

function createMatch(wsA, wsB, opts){
  const cA = clientsByWs.get(wsA);
  const cB = clientsByWs.get(wsB);
  if (!cA || !cB) return null;

  // Deterministic team assignment: lower username = 'us' (red, bottom).
  let usClient, themClient;
  if (cA.username < cB.username){ usClient = cA;  themClient = cB; }
  else                            { usClient = cB;  themClient = cA; }

  const id = String(nextMatchId++);
  const noKeys = !!(opts && opts.noKeys);
  const match = {
    id,
    noKeys,
    playerA: { ws: usClient.ws,   username: usClient.username,   team: 'us',   equipped: usClient.equipped   || [null,null,null], isAdmin: !!usClient.isAdmin,   tag: usClient.tag   || '' },
    playerB: { ws: themClient.ws, username: themClient.username, team: 'them', equipped: themClient.equipped || [null,null,null], isAdmin: !!themClient.isAdmin, tag: themClient.tag || '' },
    players: {},
    ball: { x: START_BALL.x, y: START_BALL.y, rot: 0 },
    ballHolder: null,
    ballOffset: { x: 0, y: 0 },
    mode: 'kick',
    turn: 1,
    scoreUs: 0,
    scoreThem: 0,
    aimsA: null,                // us-team aims (incl. zonePlacements)
    aimsB: null,                // them-team aims (incl. zonePlacements)
    // Per-player, per-zone placements for player-placed zones, set at the
    // start of each turn's animation from the locked-in aims. Reset at end
    // of turn so each planning phase requires fresh placements.
    placedZones: {},
    animating: false,
    runtime: null,
    clash: null,                // { ctx, scoresA, scoresB, resolved? }

    // ── Phase 3a / 3b / 3c / Phase 6 ability execution state ───────────
    // abilitiesById:  shared ability config pool
    // cooldowns:      { [playerId]: { [abilityId]: turnsRemaining } }
    // statMods:       per-player additive stat mods used by speedFactor etc.
    // activeMods:     active duration effects we still need to expire later
    //                 [{ pid, stat, amount, turnsLeft }]
    // pendingRewards: deferred firings from `appliesNext` abilities
    //                 [{ pid, abilityId, turnsLeft }]
    abilitiesById: {
      ...(usClient.abilities   || {}),
      ...(themClient.abilities || {})
    },
    cooldowns: {},
    statMods: {},
    activeMods: [],
    pendingRewards: [],
    clashWinsThisTurn: new Set()
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
  const me  = role === 'us' ? match.playerA : match.playerB;
  const opp = role === 'us' ? match.playerB : match.playerA;
  // If there's an active clash on the server, tell the resuming client about
  // it so they can rebuild the QTE overlay instead of being stuck on the
  // field while the opponent waits. The new format carries everything the
  // client needs to drop back into the right round at the right pace.
  let clashInfo = null;
  if (match.clash){
    clashInfo = {
      ctx: match.clash.ctx,
      roundSpeeds: match.clash.roundSpeeds || [],
      currentRound: match.clash.currentRound | 0,
      scoresA: (match.clash.scoresA || []).slice(),
      scoresB: (match.clash.scoresB || []).slice(),
      resolved: match.clash.resolved || null
    };
  }
  return {
    type: 'match-start',
    matchId: match.id,
    opponent: opp.username,
    role,
    players: serializeAllPlayers(match),
    state: snapshotState(match),
    turn: match.turn,
    target: SCORE_TARGET,
    // Identity for the in-match HUD on both sides.
    redUsername:  match.playerA.username,
    blueUsername: match.playerB.username,
    redTag:       match.playerA.tag || '',
    blueTag:      match.playerB.tag || '',
    redIsAdmin:   !!match.playerA.isAdmin,
    blueIsAdmin:  !!match.playerB.isAdmin,
    // Resume aids.
    animating: !!match.animating,
    iLocked: role === 'us' ? !!match.aimsA : !!match.aimsB,
    oppLocked: role === 'us' ? !!match.aimsB : !!match.aimsA,
    clash: clashInfo,
    zones: serializeActiveZones(match)
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
// Temporary stat mods (from fired ability rewards) stack on top of base stars.
// The factor is computed on demand, so the next time a turn animates the
// modded value is what drives speed/shot/stamina.
function effStat(m, id, key){
  const base = (m.players[id] && m.players[id].stats && m.players[id].stats[key]) | 0;
  const mod  = (m.statMods && m.statMods[id] && m.statMods[id][key]) | 0;
  return base + mod;
}
const speedFactor    = (m, id) => statFactor(effStat(m, id, 'speed'));
const staminaFactor  = (m, id) => statFactor(effStat(m, id, 'stamina'));
const shootingFactor = (m, id) => statFactor(effStat(m, id, 'shooting'));

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
  // Merge zone placements from both sides. Each side only owns its own team's
  // player ids, so collisions can't happen in practice.
  const placements = {};
  const merge = (src) => {
    if (!src) return;
    for (const pid of Object.keys(src)){
      placements[pid] = placements[pid] || {};
      for (const zid of Object.keys(src[pid] || {})){
        const z = src[pid][zid];
        if (z && typeof z.x === 'number' && typeof z.y === 'number'){
          placements[pid][zid] = {
            x: clamp(z.x, F_LEFT, F_RIGHT),
            y: clamp(z.y, F_TOP,  F_BOT)
          };
        }
      }
    }
  };
  merge(match.aimsA && match.aimsA.zonePlacements);
  merge(match.aimsB && match.aimsB.zonePlacements);
  match.placedZones = placements;
  // Capture activations for this turn so the evaluator can use them.
  match.activationsThisTurn = {};
  const collectActs = (src) => {
    if (!src) return;
    for (const pid of Object.keys(src)){
      if (!match.activationsThisTurn[pid]) match.activationsThisTurn[pid] = {};
      for (const abId of Object.keys(src[pid] || {})){
        if (src[pid][abId]) match.activationsThisTurn[pid][abId] = true;
      }
    }
  };
  collectActs(match.aimsA && match.aimsA.activations);
  collectActs(match.aimsB && match.aimsB.activations);
  match.aimsA = null;
  match.aimsB = null;
}

// ── Tick the simulation for one match ──────────────────────────────────────
function tickMatch(match){
  if (!match.animating) return;
  if (match.clash) return; // QTE owns the floor (post-animation)

  const r = match.runtime;
  if (!r) return;

  const now = Date.now();
  const elapsed = now - r.t0;

  // Update mover positions. Players already in a clash freeze where they
  // collided; the animation continues for everyone else.
  let allRunsDone = true;
  for (const run of r.runs){
    if (r.activeClashIds.has(run.moverId)) continue; // frozen, treat as done
    const dur = RUN_DUR / Math.max(0.1, speedFactor(match, run.moverId));
    const k = Math.min(1, elapsed / dur);
    const ek = 1 - Math.pow(1 - k, 3);
    const p = match.players[run.moverId];
    p.x = run.startPos.x + (run.endPos.x - run.startPos.x) * ek;
    p.y = run.startPos.y + (run.endPos.y - run.startPos.y) * ek;
    if (k < 1) allRunsDone = false;
  }

  // Clash detection. Pairs that collide stop in place + get broadcast as a
  // "clash-marker" for visual feedback, but the QTE doesn't start yet —
  // it waits until the animation finishes.
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
        broadcastMatch(match, {
          type: 'clash-marker',
          moverId: mover.id,
          opponentId: id,
          x: round1((mover.x + other.x) / 2),
          y: round1((mover.y + other.y) / 2)
        });
      }
    }
  }

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

  if (allRunsDone && ballDone){
    // Snap final positions for non-clashing players. Clashing players stay
    // wherever they collided.
    for (const run of r.runs){
      if (r.activeClashIds.has(run.moverId)) continue;
      match.players[run.moverId].x = run.endPos.x;
      match.players[run.moverId].y = run.endPos.y;
    }
    // If there are pending clashes, start the first QTE now — between the
    // animation and the next turn. Otherwise wrap up the turn normally.
    if (r.clashQueue.length > 0){
      startNextClashFromQueue(match);
    } else {
      endTurnServer(match);
    }
  }
}

// ── Clash queue helpers ────────────────────────────────────────────────────
const CLASH_SPEED_MIN_MS = 900;
const CLASH_SPEED_MAX_MS = 1700;
function randomClashSpeed(){
  return Math.round(CLASH_SPEED_MIN_MS + Math.random() * (CLASH_SPEED_MAX_MS - CLASH_SPEED_MIN_MS));
}
function startNextClashFromQueue(match){
  const r = match.runtime;
  if (!r || r.clashQueue.length === 0) return false;
  const ctx = r.clashQueue.shift();
  const roundSpeeds = [randomClashSpeed(), randomClashSpeed(), randomClashSpeed()];
  match.clash = {
    ctx,
    roundSpeeds,
    scoresA: [],
    scoresB: [],
    currentRound: 0,
    aDone: false,
    bDone: false,
    resolved: null
  };
  broadcastMatch(match, { type: 'clash-start', ctx, roundSpeeds });
  return true;
}

// ── Turn end / goal / kickoff ──────────────────────────────────────────────
function endTurnServer(match){
  for (const id in match.players){
    if (match.players[id].frozen > 0) match.players[id].frozen -= 1;
  }
  // Roll any active duration-bound stat mods forward by one turn first; any
  // that just expired get their delta reversed inside tickActiveMods.
  tickActiveMods(match);
  // Evaluate equipped abilities; fire those the player activated and whose
  // requirements are met. Rewards mutate match state for the turn we're
  // about to start. Auto-clash can additionally set match.clash so the next
  // thing both players do is the QTE.
  const { fired, autoClashStarted } = evaluateAbilities(match);
  decrementCooldowns(match);
  match.clashWinsThisTurn = new Set();
  // Activations are one-turn-only; clear them after this turn's evaluation.
  match.activationsThisTurn = {};
  match.turn += 1;
  match.animating = false;
  match.runtime = null;
  for (const ev of fired){
    broadcastMatch(match, { type: 'ability-fired', ...ev });
  }
  // Send turn-end with the zones snapshot BEFORE clearing placements — so
  // the client briefly sees the zones from the turn that just resolved.
  broadcastMatch(match, {
    type: 'turn-end',
    state: snapshotState(match),
    turn: match.turn,
    zones: serializeActiveZones(match)
  });
  // Now clear so the next planning phase starts with no player-placed zones.
  match.placedZones = {};
  // If auto-clash fired, immediately broadcast clash-start so both clients
  // jump into the QTE overlay. The aims handler is gated on match.clash so
  // neither side can lock in until the clash resolves.
  if (autoClashStarted && match.clash && !match.clash.resolved){
    broadcastMatch(match, { type: 'clash-start', ctx: match.clash.ctx });
  }
}

// ── Phase 3a/3b: Ability evaluator ─────────────────────────────────────────
function decrementCooldowns(match){
  if (!match.cooldowns) return;
  for (const pid of Object.keys(match.cooldowns)){
    const m = match.cooldowns[pid];
    for (const abId of Object.keys(m)){
      m[abId] = Math.max(0, (m[abId] | 0) - 1);
      if (m[abId] === 0) delete m[abId];
    }
    if (Object.keys(m).length === 0) delete match.cooldowns[pid];
  }
}
function getCooldown(match, pid, abId){
  return (match.cooldowns && match.cooldowns[pid] && match.cooldowns[pid][abId]) | 0;
}
function setCooldown(match, pid, abId, turns){
  if (!match.cooldowns[pid]) match.cooldowns[pid] = {};
  match.cooldowns[pid][abId] = Math.max(0, turns | 0);
}
function ensureStatMods(match, pid){
  if (!match.statMods[pid]) match.statMods[pid] = { speed: 0, shooting: 0, stamina: 0 };
  return match.statMods[pid];
}

// ── Phase 3b/3c: zone helpers ──────────────────────────────────────────────
// Resolves the center of a zone to absolute field coords. Fixed-offset zones
// follow their owner; player-placed zones use the coordinates the player
// stamped in this turn's aims. Returns null if a player-placed zone hasn't
// been placed (i.e. the player skipped it this planning phase).
function zoneCenter(match, ownerId, zone){
  if (zone.placement === 'player-placed'){
    const p = match.placedZones && match.placedZones[ownerId] && match.placedZones[ownerId][zone.id];
    if (!p) return null;
    return { x: p.x, y: p.y };
  }
  const p = match.players[ownerId];
  if (!p) return null;
  return { x: p.x + ((zone.offsetX | 0) || 0), y: p.y + ((zone.offsetY | 0) || 0) };
}
function isInZone(pos, zone, center){
  if (!pos || !center) return false;
  const dx = pos.x - center.x;
  const dy = pos.y - center.y;
  return hypot(dx, dy) <= ((zone.radius | 0) || 0);
}
// Returns the id of the first matching target in the zone, or null. Used by
// both requirement evaluation and the auto-clash reward.
function zoneTargetPresent(match, ownerId, zone){
  const center = zoneCenter(match, ownerId, zone);
  if (!center) return null;
  const ownerTeam = SLOT_TO_TEAM[ownerId];
  const target = zone.target || 'enemy';
  if (target === 'ball'){
    return isInZone(match.ball, zone, center) ? 'ball' : null;
  }
  if (target === 'enemy-with-ball'){
    const h = match.ballHolder;
    if (!h) return null;
    if (SLOT_TO_TEAM[h] === ownerTeam) return null;
    if (isInZone(match.players[h], zone, center)) return h;
    return null;
  }
  if (target === 'self'){
    return isInZone(match.players[ownerId], zone, center) ? ownerId : null;
  }
  // teammate or enemy
  for (const id in match.players){
    if (id === ownerId && target !== 'self') continue;
    const sameTeam = SLOT_TO_TEAM[id] === ownerTeam;
    if (target === 'teammate' && !sameTeam) continue;
    if (target === 'enemy'    &&  sameTeam) continue;
    if (isInZone(match.players[id], zone, center)) return id;
  }
  return null;
}
function findZone(cfg, zoneId){
  const zones = (cfg && Array.isArray(cfg.zones)) ? cfg.zones : [];
  return zones.find(z => z && z.id === zoneId) || null;
}

function evalRequirementsMet(match, pid, cfg){
  const requirements = (cfg && Array.isArray(cfg.requirements)) ? cfg.requirements : [];
  if (requirements.length === 0) return true;
  for (const req of requirements){
    if (!req || !req.kind) continue;
    if (req.kind === 'clash-and-win'){
      if (!match.clashWinsThisTurn || !match.clashWinsThisTurn.has(pid)) return false;
    } else if (req.kind === 'zone'){
      const zone = findZone(cfg, req.zoneId);
      if (!zone) return false;
      // Player-placed zones are checked by zoneTargetPresent — which falls
      // through `zoneCenter` and returns null if the player didn't place it.
      if (!zoneTargetPresent(match, pid, zone)) return false;
    } else {
      return false;
    }
  }
  return true;
}

// Push or refresh an active stat mod for a player. `amount` is signed.
function pushActiveMod(match, pid, stat, amount, turns){
  if (!amount || !turns || turns <= 0) return;
  ensureStatMods(match, pid)[stat] = (ensureStatMods(match, pid)[stat] | 0) + amount;
  match.activeMods.push({ pid, stat, amount, turnsLeft: turns });
}
// Decrement durations on active mods; reverse and drop expired ones.
function tickActiveMods(match){
  if (!Array.isArray(match.activeMods)) return;
  const keep = [];
  for (const m of match.activeMods){
    m.turnsLeft -= 1;
    if (m.turnsLeft <= 0){
      // Reverse the effect.
      const mods = ensureStatMods(match, m.pid);
      mods[m.stat] = (mods[m.stat] | 0) - m.amount;
    } else {
      keep.push(m);
    }
  }
  match.activeMods = keep;
}

function fireRewards(match, pid, ability, fired){
  const cfg = ability.config || {};
  const rewards = Array.isArray(cfg.rewards) ? cfg.rewards : [];
  const applied = [];
  // At most one auto-clash per evaluation pass — we set match.clash exactly
  // once. If an ability has multiple auto-clash rewards, the first wins.
  let pendingClash = null;
  for (const r of rewards){
    if (!r || !r.kind) continue;
    if (r.kind === 'stat-boost'){
      const stat = (r.stat === 'speed' || r.stat === 'shooting' || r.stat === 'stamina') ? r.stat : 'speed';
      const amt  = (r.amount | 0);
      const dur  = Math.max(1, (r.durationTurns | 0) || 1);
      pushActiveMod(match, pid, stat, amt, dur);
      applied.push({ kind: 'stat-boost', stat, amount: amt, durationTurns: dur });
    } else if (r.kind === 'action-boost'){
      // The boost was already applied during planning on the client side
      // (it stretches the planning range). The server already accepts the
      // longer endPos because we don't clamp to MAX_LEN here, so this server
      // record is mainly for client toast + telemetry parity.
      const mag = (typeof r.magnitude === 'number' && r.magnitude > 0) ? r.magnitude : 1;
      applied.push({ kind: 'action-boost', magnitude: mag, action: cfg.action || 'none' });
    } else if (r.kind === 'give-ball'){
      const p = match.players[pid];
      if (p){
        match.ballHolder = pid;
        match.ballOffset = { x: 0, y: BALL_OFFSET_MAG };
        match.ball.x = p.x + match.ballOffset.x;
        match.ball.y = p.y + match.ballOffset.y;
        match.mode = 'kick';
        applied.push({ kind: 'give-ball' });
      }
    } else if (r.kind === 'teleport-to-ball'){
      const p = match.players[pid];
      if (p){
        p.x = match.ball.x;
        p.y = match.ball.y;
        applied.push({ kind: 'teleport-to-ball' });
      }
    } else if (r.kind === 'teleport-to-zone'){
      const zone = findZone(cfg, r.zoneId);
      if (!zone) continue;
      const owner = match.players[pid];
      if (!owner) continue;
      const center = zoneCenter(match, pid, zone);
      if (!center) continue; // player-placed but not placed this turn
      // Clamp to playable field bounds so we never teleport into the wall.
      owner.x = Math.max(F_LEFT + PLAYER_R, Math.min(F_RIGHT - PLAYER_R, center.x));
      owner.y = Math.max(F_TOP  + PLAYER_R, Math.min(F_BOT   - PLAYER_R, center.y));
      // If this player is holding the ball, the ball moves too.
      if (match.ballHolder === pid){
        match.ball.x = owner.x + match.ballOffset.x;
        match.ball.y = owner.y + match.ballOffset.y;
      }
      applied.push({ kind: 'teleport-to-zone', zoneId: r.zoneId, x: round1(owner.x), y: round1(owner.y) });
    } else if (r.kind === 'auto-clash'){
      if (match.clash || pendingClash) continue; // never stack clashes
      const zone = findZone(cfg, r.zoneId);
      if (!zone) continue;
      const targetId = zoneTargetPresent(match, pid, zone);
      // Only enemies trigger auto-clash; ball/teammate/self targets skip.
      if (!targetId || targetId === 'ball') continue;
      if (SLOT_TO_TEAM[targetId] === SLOT_TO_TEAM[pid]) continue;
      pendingClash = { moverId: pid, opponentId: targetId, zoneId: r.zoneId };
    }
  }
  if (pendingClash){
    match.clash = {
      ctx: { moverId: pendingClash.moverId, opponentId: pendingClash.opponentId },
      scoresA: [], scoresB: [], resolved: null
    };
    applied.push({ kind: 'auto-clash', zoneId: pendingClash.zoneId, targetId: pendingClash.opponentId });
  }
  if (applied.length > 0){
    fired.push({
      playerId: pid,
      abilityId: ability.id,
      abilityName: ability.name,
      rewards: applied,
      soundUrl:    cfg.soundUrl    || null,
      cutsceneUrl: cfg.cutsceneUrl || null
    });
  }
  return applied.length > 0;
}

function evaluateAbilities(match){
  const fired = [];
  if (!match.abilitiesById) return { fired, autoClashStarted: false };

  // 1) Fire any pending rewards from the previous turn (appliesNext path).
  const stillPending = [];
  for (const p of (match.pendingRewards || [])){
    p.turnsLeft = (p.turnsLeft | 0) - 1;
    if (p.turnsLeft > 0){ stillPending.push(p); continue; }
    const ability = match.abilitiesById[p.abilityId];
    if (!ability) continue;
    const before = !!match.clash;
    if (fireRewards(match, p.pid, ability, fired)){
      const cdN = (ability.config && ability.config.cooldownTurns) | 0;
      setCooldown(match, p.pid, p.abilityId, cdN > 0 ? cdN + 1 : 0);
    }
    if (!before && match.clash){
      match.pendingRewards = stillPending;
      return { fired, autoClashStarted: true };
    }
  }
  match.pendingRewards = stillPending;

  // 2) Evaluate ACTIVATED abilities only — no more passive auto-fire.
  const acts = match.activationsThisTurn || {};
  for (const pid of Object.keys(match.players)){
    const player = match.players[pid];
    if (!player || !Array.isArray(player.weapons)) continue;
    for (const abId of player.weapons){
      if (!abId) continue;
      if (!(acts[pid] && acts[pid][abId])) continue; // not activated this turn
      const ability = match.abilitiesById[abId];
      if (!ability) continue;
      if (getCooldown(match, pid, abId) > 0) continue;
      const cfg = ability.config || {};
      // Instant-fire abilities fire via handleFireAbility, not at turn-end.
      // Defensive: if a client somehow sends an activation for one, skip it.
      if (cfg.action === 'none' && cfg.noLockIn) continue;
      if (cfg.scope === 'on-ball'  && match.ballHolder !== pid) continue;
      if (cfg.scope === 'off-ball' && match.ballHolder === pid) continue;
      // If the ability has requirements, they must be met THIS turn for the
      // reward to fire. No-requirement abilities fire immediately on use.
      if (!evalRequirementsMet(match, pid, cfg)) continue;
      // `appliesNext` defers the reward by one turn — useful for setup
      // abilities where the effect is supposed to land later.
      if (cfg.appliesNext){
        match.pendingRewards.push({ pid, abilityId: abId, turnsLeft: 1 });
        // Tag the deferral as a "fired" event so the client gets feedback
        // immediately, with no concrete rewards applied yet.
        fired.push({
          playerId: pid,
          abilityId: abId,
          abilityName: ability.name,
          rewards: [{ kind: 'deferred-next-turn' }],
          soundUrl:    cfg.soundUrl    || null,
          cutsceneUrl: cfg.cutsceneUrl || null
        });
        // Still consumes cooldown so you can't spam-defer.
        setCooldown(match, pid, abId, ((cfg.cooldownTurns | 0) > 0) ? ((cfg.cooldownTurns | 0) + 1) : 0);
        continue;
      }
      const before = !!match.clash;
      if (!fireRewards(match, pid, ability, fired)) continue;
      setCooldown(match, pid, abId, ((cfg.cooldownTurns | 0) > 0) ? ((cfg.cooldownTurns | 0) + 1) : 0);
      if (!before && match.clash){
        return { fired, autoClashStarted: true };
      }
    }
  }
  return { fired, autoClashStarted: false };
}

// ── Phase 3b: zone serialization for client rendering ──────────────────────
function serializeActiveZones(match){
  const out = [];
  if (!match.abilitiesById) return out;
  for (const pid of Object.keys(match.players)){
    const player = match.players[pid];
    if (!player || !Array.isArray(player.weapons)) continue;
    for (const abId of player.weapons){
      if (!abId) continue;
      const ability = match.abilitiesById[abId];
      if (!ability) continue;
      const cfg = ability.config || {};
      const zones = Array.isArray(cfg.zones) ? cfg.zones : [];
      for (const z of zones){
        if (!z || !z.id) continue;
        const center = zoneCenter(match, pid, z);
        if (!center) continue; // player-placed but not placed yet
        out.push({
          ownerId:   pid,
          abilityId: abId,
          zoneId:    z.id,
          cx:        round1(center.x),
          cy:        round1(center.y),
          radius:    (z.radius | 0) || 0,
          color:     z.color || '#ef2b3a',
          placement: z.placement || 'fixed-offset'
        });
      }
    }
  }
  return out;
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
  if (!match || !match.clash || match.clash.resolved) return;
  const cl = match.clash;
  // The round number in the message must match the current round on the
  // server. Drop stale rounds (e.g. duplicate submissions).
  const round = ((msg.round | 0) - 1);
  if (round !== cl.currentRound) return;
  const isUs = c.username === match.playerA.username;
  if (isUs && cl.aDone) return;
  if (!isUs && cl.bDone) return;
  const arr = isUs ? cl.scoresA : cl.scoresB;
  const score = Math.max(0, Math.min(100, msg.score | 0));
  arr[cl.currentRound] = score;
  if (isUs) cl.aDone = true; else cl.bDone = true;
  // Tell the opponent the score landed (for the running total display).
  const oppWs = isUs ? match.playerB.ws : match.playerA.ws;
  send(oppWs, { type: 'opp-qte-score', round: cl.currentRound + 1, score });
  // When both sides are done with this round, advance — or resolve.
  if (cl.aDone && cl.bDone){
    cl.currentRound += 1;
    cl.aDone = false;
    cl.bDone = false;
    if (cl.currentRound >= QTE_ROUNDS){
      resolveClashServer(match);
    } else {
      broadcastMatch(match, { type: 'clash-round-next', round: cl.currentRound + 1 });
    }
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
  // Track for ability requirements: who won a clash this turn?
  if (match.clashWinsThisTurn) match.clashWinsThisTurn.add(winnerId);
  broadcastMatch(match, { type: 'clash-outcome', outcome });
}
function handleClashDismiss(ws){
  const c = clientsByWs.get(ws);
  if (!c || !c.matchId) return;
  const match = matches.get(c.matchId);
  if (!match || !match.clash || !match.clash.resolved) return;
  applyClashOutcomeServer(match, match.clash.resolved);
  match.clash = null;
  broadcastMatch(match, { type: 'clash-dismiss' });
  broadcastMatch(match, { type: 'turn-state', state: snapshotState(match) });
  // Two cases:
  //   1. Post-animation collision clash: runtime is still set. Chain into
  //      the next queued clash, or call endTurnServer if the queue is empty.
  //   2. Auto-clash from an ability that fired at endTurnServer: runtime is
  //      already null because the turn has already ended. Just clear and
  //      do nothing else — the planning phase resumes.
  if (match.runtime){
    if (match.runtime.clashQueue && match.runtime.clashQueue.length > 0){
      startNextClashFromQueue(match);
    } else {
      endTurnServer(match);
    }
  }
}
// ── Instant ability fire (action='none' + noLockIn) ───────────────────────
// The player taps the weapon button mid-planning. The ability fires right
// away (no aims required), applying its rewards and starting its cooldown.
// The player can still draw a move and lock in normally for the same turn.
function handleFireAbility(ws, msg){
  const c = clientsByWs.get(ws);
  if (!c || !c.matchId) return;
  const match = matches.get(c.matchId);
  if (!match || match.animating) return;
  if (match.clash && !match.clash.resolved) return; // clash blocks new actions
  const playerId = msg && msg.playerId;
  const abilityId = msg && msg.abilityId;
  if (!playerId || !abilityId) return;
  const player = match.players[playerId];
  if (!player) return;
  // Ownership: a player can only fire abilities on their own team's players.
  const myTeam = c.username === match.playerA.username ? match.playerA.team : match.playerB.team;
  if (player.team !== myTeam) return;
  // Must actually hold that ability.
  if (!Array.isArray(player.weapons) || !player.weapons.includes(abilityId)) return;
  const ability = match.abilitiesById && match.abilitiesById[abilityId];
  if (!ability) return;
  const cfg = ability.config || {};
  // Server-enforced: only allow instant fire for action='none' + noLockIn.
  if (cfg.action !== 'none' || !cfg.noLockIn) return;
  // Scope gate (matches end-of-turn evaluator).
  if (cfg.scope === 'on-ball'  && match.ballHolder !== playerId) return;
  if (cfg.scope === 'off-ball' && match.ballHolder === playerId) return;
  // Cooldown gate.
  if (getCooldown(match, playerId, abilityId) > 0) return;
  const fired = [];
  if (!fireRewards(match, playerId, ability, fired)) return;
  const cdN = (cfg.cooldownTurns | 0);
  setCooldown(match, playerId, abilityId, cdN > 0 ? cdN + 1 : 0);
  for (const ev of fired){
    broadcastMatch(match, { type: 'ability-fired', ...ev });
  }
  // Push the new state so any teleport/give-ball is reflected immediately.
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
  const winnerKeys = match.noKeys ? 0 : 200;
  const loserKeys  = match.noKeys ? 0 : 25;
  send(match.playerA.ws, { type: 'match-end', won: aWon, reason: 'score',
                            keys: aWon ? winnerKeys : loserKeys, noKeys: match.noKeys,
                            scoreUs: match.scoreUs, scoreThem: match.scoreThem });
  send(match.playerB.ws, { type: 'match-end', won: bWon, reason: 'score',
                            keys: bWon ? winnerKeys : loserKeys, noKeys: match.noKeys,
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
        isAdmin: !!msg.isAdmin,
        tag: (typeof msg.tag === 'string' ? msg.tag.slice(0, 24) : '') || '',
        // Ability configs for any weapon any equipped player holds. Used at
        // match-create time to populate match.abilitiesById, and re-applied
        // on roster updates so changes mid-session show up next match.
        abilities: (msg.abilities && typeof msg.abilities === 'object') ? msg.abilities : {},
        matchId: resumeMatch ? resumeMatch.id : null
      };
      clientsByWs.set(ws, info);
      clientsByUser.set(u, ws);
      // If this user is in a match, sync their identity into the match record
      // so subsequent buildMatchStart / opponent lookups use the latest values.
      if (resumeMatch){
        if (resumeMatch.playerA.username === u){
          resumeMatch.playerA.isAdmin = info.isAdmin;
          resumeMatch.playerA.tag = info.tag;
        } else if (resumeMatch.playerB.username === u){
          resumeMatch.playerB.isAdmin = info.isAdmin;
          resumeMatch.playerB.tag = info.tag;
        }
      }
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
      if (c){
        c.equipped = msg.equipped || c.equipped;
        if (typeof msg.isAdmin === 'boolean') c.isAdmin = msg.isAdmin;
        if (typeof msg.tag === 'string') c.tag = msg.tag.slice(0, 24);
        if (msg.abilities && typeof msg.abilities === 'object') c.abilities = msg.abilities;
      }
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
      // Invite-created matches don't pay keys to either side.
      createMatch(ws, target, { noKeys: true });
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
      // A pending clash (from either a collision or an auto-clash reward)
      // blocks lock-in. The aims arriving here would never be acted on
      // anyway since tickMatch bails while clash is active.
      if (match.clash && !match.clash.resolved) break;
      const slot = c.username === match.playerA.username ? 'aimsA' : 'aimsB';
      const placements = (msg.zonePlacements && typeof msg.zonePlacements === 'object') ? msg.zonePlacements : {};
      // Ability activations: { [playerId]: { [abilityId]: true } } — the
      // player flagged these to fire on this turn. The evaluator only
      // considers activated abilities (no more passive auto-fire).
      const activations = (msg.activations && typeof msg.activations === 'object') ? msg.activations : {};
      match[slot] = {
        aims: msg.aims || {},
        ballAim: msg.ballAim || null,
        mode: msg.mode || 'kick',
        zonePlacements: placements,
        activations
      };
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
    case 'fire-ability': handleFireAbility(ws, msg); break;
    case 'match-quit': {
      if (!c || !c.matchId) break;
      const match = matches.get(c.matchId);
      if (!match) break;
      const oppWs = c.username === match.playerA.username ? match.playerB.ws : match.playerA.ws;
      const winnerKeys = match.noKeys ? 0 : 200;
      const quitter = c.username;
      send(ws,    { type: 'match-end', won: false, reason: 'quit', quitter,
                     keys: 0, noKeys: match.noKeys,
                     scoreUs: match.scoreUs, scoreThem: match.scoreThem });
      send(oppWs, { type: 'match-end', won: true,  reason: 'opponent-quit', quitter,
                     keys: winnerKeys, noKeys: match.noKeys,
                     scoreUs: match.scoreUs, scoreThem: match.scoreThem });
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
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    try { handleMessage(ws, JSON.parse(data.toString())); } catch(_){}
  });
  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => {});
});

// Heartbeat: idle WebSockets get killed by upstream load balancers (Render's
// default is ~110s with no traffic). Ping every 25s. Mobile tabs throttle in
// the background, so we allow up to 3 missed pings (~75s of unresponsiveness)
// before terminating — that keeps Render happy without nuking a flaky tab.
setInterval(() => {
  for (const ws of wss.clients){
    if (!ws.isAlive){
      ws._missedPongs = (ws._missedPongs | 0) + 1;
      if (ws._missedPongs >= 3){
        try { ws.terminate(); } catch(_){}
        continue;
      }
    } else {
      ws._missedPongs = 0;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch(_){}
  }
}, 25000);

httpServer.listen(PORT, () => {
  console.log(`Red Key server ready: http://localhost:${PORT}/`);
});
