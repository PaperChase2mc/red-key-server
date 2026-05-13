// Synthetic two-client test harness for the Red Key game server.
//
// Spawns a local instance of the server on PORT 3099, opens two WebSocket
// connections (each pretending to be a player), and walks them through
// scripted multiplayer scenarios. Asserts the server's responses match what
// the client code expects.
//
// Run with: `npm test` (or `node test/harness.mjs`).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, '..', 'server.mjs');
const PORT = 3099;
const WS_URL = `ws://localhost:${PORT}`;

// ── Test client ─────────────────────────────────────────────────────────────
class TestClient {
  constructor(username){
    this.username = username;
    this.received = []; // every message received
    this.waiters  = []; // { type, resolve, reject, timer, predicate }
    this.ws = null;
    this.openP = null;
    this.closed = false;
  }

  open(){
    if (this.openP) return this.openP;
    this.openP = new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('connect timeout')), 5000);
      ws.on('open', () => { clearTimeout(timer); resolve(); });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          // If a waiter is already expecting this message, hand it directly
          // to the FIRST matching waiter and don't buffer the message — the
          // waiter "consumes" it. Otherwise buffer for future expect()/drain().
          for (let i = 0; i < this.waiters.length; i++){
            const w = this.waiters[i];
            if (w.predicate(msg)){
              clearTimeout(w.timer);
              this.waiters.splice(i, 1);
              w.resolve(msg);
              return;
            }
          }
          this.received.push(msg);
        } catch (_){}
      });
      ws.on('close', () => { this.closed = true; });
    });
    return this.openP;
  }

  send(msg){
    if (!this.ws || this.ws.readyState !== 1) throw new Error(`${this.username}: ws not open`);
    this.ws.send(JSON.stringify(msg));
  }

  hello(extra = {}){
    this.send({ type: 'hello', username: this.username, equipped: [null, null, null], ...extra });
  }

  // Wait for the next message matching a predicate. Default predicate is
  // "type equals X". Times out after `timeoutMs`.
  expect(typeOrPredicate, timeoutMs = 5000){
    const predicate = typeof typeOrPredicate === 'function'
      ? typeOrPredicate
      : (m) => m.type === typeOrPredicate;
    return new Promise((resolve, reject) => {
      // Drain anything already received that matches.
      for (let i = 0; i < this.received.length; i++){
        if (predicate(this.received[i])){
          // Consume so we don't match it again.
          const [msg] = this.received.splice(i, 1);
          return resolve(msg);
        }
      }
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(w);
        if (idx >= 0) this.waiters.splice(idx, 1);
        const label = typeof typeOrPredicate === 'string' ? typeOrPredicate : 'predicate';
        reject(new Error(`${this.username}: timed out waiting for ${label}. Got: ${this.received.map(m=>m.type).join(', ')}`));
      }, timeoutMs);
      const w = { predicate, resolve: (m) => resolve(m), reject, timer };
      this.waiters.push(w);
    });
  }

  // Fire-and-forget: drain any matching message if present, otherwise no-op.
  // Doesn't wait.
  drain(typeOrPredicate){
    const predicate = typeof typeOrPredicate === 'function'
      ? typeOrPredicate
      : (m) => m.type === typeOrPredicate;
    for (let i = 0; i < this.received.length; i++){
      if (predicate(this.received[i])){
        const [msg] = this.received.splice(i, 1);
        return msg;
      }
    }
    return null;
  }

  // Asserts that no message of `type` arrived within `quietMs`. Useful for
  // confirming "second lock-in was ignored" style invariants.
  async expectQuiet(typeOrPredicate, quietMs = 300){
    await sleep(quietMs);
    const found = this.drain(typeOrPredicate);
    if (found){
      const label = typeof typeOrPredicate === 'string' ? typeOrPredicate : 'predicate';
      throw new Error(`${this.username}: expected no ${label}, but got one: ${JSON.stringify(found)}`);
    }
  }

  close(){
    if (this.ws) try { this.ws.close(); } catch(_){}
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Server lifecycle ────────────────────────────────────────────────────────
let serverProcess = null;
let serverLog = '';
function startServer(){
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER_PATH], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    serverProcess = proc;
    let ready = false;
    const onData = (chunk) => {
      const s = chunk.toString();
      serverLog += s;
      if (!ready && /server ready/i.test(s)){
        ready = true;
        resolve();
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => {
      if (!ready) reject(new Error(`server exited before ready (code ${code})\n--- server log ---\n${serverLog}`));
    });
    setTimeout(() => {
      if (!ready) reject(new Error(`server never reported ready in 6s\n--- server log ---\n${serverLog}`));
    }, 6000);
  });
}
function stopServer(){
  if (serverProcess){
    try { serverProcess.kill('SIGTERM'); } catch(_){}
    serverProcess = null;
  }
}

// ── Helpers used by multiple scenarios ───────────────────────────────────────
function uniq(prefix){ return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`; }

// Open two clients, hello, queue, wait for both to be paired into a match.
async function newMatch(usernameA, usernameB){
  const a = new TestClient(usernameA || uniq('a'));
  const b = new TestClient(usernameB || uniq('b'));
  await a.open();
  await b.open();
  a.hello();
  b.hello();
  await a.expect('welcome');
  await b.expect('welcome');
  a.send({ type: 'queue' });
  b.send({ type: 'queue' });
  await a.expect('queued');
  await b.expect('queued');
  const ms1 = await a.expect('match-start');
  const ms2 = await b.expect('match-start');
  if (ms1.matchId !== ms2.matchId) throw new Error('match IDs differ');
  return { a, b, matchA: ms1, matchB: ms2 };
}

// Submit a no-op aims payload for the team this side owns.
function submitNoOpAims(client, matchStart){
  const aims = {};
  // All player slot ids on the team owned by this client.
  const players = matchStart.players || {};
  const myTeam = matchStart.role === 'us' ? 'us' : 'them';
  for (const id of Object.keys(players)){
    if (players[id].team === myTeam){
      aims[id] = null; // null = no move planned for this player
    }
  }
  client.send({ type: 'aims', aims, ballAim: null, mode: 'kick' });
}

// ── Scenarios ───────────────────────────────────────────────────────────────
async function testHelloBasic(){
  const a = new TestClient(uniq('hello'));
  await a.open();
  a.hello();
  const w = await a.expect('welcome');
  if (w.username !== a.username) throw new Error(`welcome username mismatch: ${w.username}`);
  a.close();
}

async function testHelloEmptyUsername(){
  // Empty username should produce an error and not crash the server.
  const a = new TestClient('');
  await a.open();
  a.send({ type: 'hello', username: '', equipped: [null, null, null] });
  const err = await a.expect('error');
  if (!/username/i.test(err.message || '')) throw new Error(`expected username error, got: ${err.message}`);
  a.close();
}

async function testMatchmaking(){
  const { a, b, matchA, matchB } = await newMatch();
  if (!matchA.players || !matchB.players) throw new Error('match-start missing players');
  if (matchA.role === matchB.role) throw new Error('both clients got same role');
  a.close(); b.close();
}

async function testOneTurnHappyPath(){
  const { a, b, matchA, matchB } = await newMatch();
  submitNoOpAims(a, matchA);
  // a should get opponent-locked from neither side yet
  // wait: server sends opponent-locked to opp when first side locks
  await b.expect('opponent-locked');
  submitNoOpAims(b, matchB);
  await a.expect('opponent-locked');
  // Animation streams turn-state messages; eventually turn-end arrives.
  const endA = await a.expect('turn-end', 8000);
  const endB = await b.expect('turn-end', 8000);
  if (endA.turn !== 2 || endB.turn !== 2) throw new Error(`expected turn 2, got ${endA.turn}/${endB.turn}`);
  a.close(); b.close();
}

async function testQuitDuringMatch(){
  const { a, b } = await newMatch();
  a.send({ type: 'match-quit' });
  const endA = await a.expect('match-end');
  const endB = await b.expect('match-end');
  if (endA.won !== false || endB.won !== true){
    throw new Error(`quit roles wrong: a.won=${endA.won}, b.won=${endB.won}`);
  }
  if (endA.reason !== 'quit' || endB.reason !== 'opponent-quit'){
    throw new Error(`quit reasons wrong: a=${endA.reason}, b=${endB.reason}`);
  }
  a.close(); b.close();
}

async function testLockInIdempotency(){
  // Sending aims twice on the same turn — server currently overwrites with
  // the second submission. The animation should NOT start until the OTHER
  // side has also submitted. So the second submission should not produce
  // any extra opponent-locked notifications to the sender, and should not
  // kick off turn-state on its own.
  const { a, b, matchA } = await newMatch();
  submitNoOpAims(a, matchA);
  await b.expect('opponent-locked');
  // Second submission from same side.
  submitNoOpAims(a, matchA);
  // The opponent might or might not get a duplicate opponent-locked — we
  // tolerate both, but no turn-state should arrive yet.
  await a.expectQuiet('turn-state', 400);
  await b.expectQuiet('turn-state', 50);
  a.close(); b.close();
}

async function testReconnectResume(){
  // Player A bounces their WS mid-match. Server should accept the new hello
  // and reply with match-start carrying the resume state.
  const { a, b, matchA } = await newMatch();
  // Drop A and reconnect with the same username.
  a.close();
  await sleep(150);
  const a2 = new TestClient(a.username);
  await a2.open();
  a2.hello();
  await a2.expect('welcome');
  // Server should push a match-start with resume info.
  const resumed = await a2.expect('match-start', 3000);
  if (resumed.matchId !== matchA.matchId){
    throw new Error(`resume gave new match id (${resumed.matchId} != ${matchA.matchId})`);
  }
  if (resumed.role !== matchA.role){
    throw new Error(`resume swapped role: ${resumed.role} != ${matchA.role}`);
  }
  // The new client should be able to continue playing.
  submitNoOpAims(a2, resumed);
  await b.expect('opponent-locked', 3000);
  // Cleanup.
  a2.close(); b.close();
}

async function testSessionReplacedDoesntKillMatch(){
  // Same username connecting twice should boot the first and transfer the
  // match. Critically: the FIRST WS's close handler must NOT cleanup the
  // match (it would end the match for the opponent prematurely).
  const { a, b, matchA } = await newMatch();
  const a2 = new TestClient(a.username);
  await a2.open();
  a2.hello();
  await a2.expect('welcome');
  // a should be closed by the server (code 4001)
  await sleep(300);
  if (!a.closed) throw new Error('first connection should have been closed');
  // b must still be in the match — quitting should still work and produce
  // a 'opponent-quit' reason rather than 'opponent-left' (which would mean
  // server cleaned up the match prematurely).
  a2.send({ type: 'match-quit' });
  const endB = await b.expect('match-end', 2000);
  if (endB.reason !== 'opponent-quit') throw new Error(`expected opponent-quit, got ${endB.reason}`);
  a2.close(); b.close();
}

async function testInviteFlowNoKeys(){
  // Invite-based matches should mark noKeys=true so match-end pays 0 to both.
  const a = new TestClient(uniq('inv-a'));
  const b = new TestClient(uniq('inv-b'));
  await a.open();
  await b.open();
  a.hello();
  b.hello();
  await a.expect('welcome');
  await b.expect('welcome');
  // A invites B.
  a.send({ type: 'invite', to: b.username });
  const inc = await b.expect('incoming-invite', 2000);
  if (inc.from !== a.username) throw new Error('invite from mismatch');
  // B accepts.
  b.send({ type: 'invite-accept', from: a.username });
  const ms1 = await a.expect('match-start');
  const ms2 = await b.expect('match-start');
  if (ms1.matchId !== ms2.matchId) throw new Error('invite match ids differ');
  // Both quit — invite matches should award 0 keys to both regardless.
  a.send({ type: 'match-quit' });
  const endA = await a.expect('match-end');
  const endB = await b.expect('match-end');
  if (endA.keys !== 0 || endB.keys !== 0){
    throw new Error(`invite match should pay 0/0, got ${endA.keys}/${endB.keys}`);
  }
  if (!endA.noKeys || !endB.noKeys){
    throw new Error(`invite match should set noKeys, got ${endA.noKeys}/${endB.noKeys}`);
  }
  a.close(); b.close();
}

async function testReconnectPreservesLockIn(){
  // Player A locks in, then bounces their WS. Server should report iLocked=true
  // in the match-start sent on resume, so the client knows it doesn't need
  // to lock in again.
  const { a, b, matchA } = await newMatch();
  submitNoOpAims(a, matchA);
  await b.expect('opponent-locked');
  // A bounces.
  a.close();
  await sleep(150);
  const a2 = new TestClient(a.username);
  await a2.open();
  a2.hello();
  await a2.expect('welcome');
  const resumed = await a2.expect('match-start', 3000);
  if (resumed.iLocked !== true){
    throw new Error(`resume after lock-in should have iLocked=true, got ${resumed.iLocked}`);
  }
  if (resumed.oppLocked !== false){
    throw new Error(`opp hasn't locked yet but oppLocked=${resumed.oppLocked}`);
  }
  // B locks in too; the turn should complete cleanly.
  submitNoOpAims(b, { players: matchA.players, role: matchA.role === 'us' ? 'them' : 'us' });
  await a2.expect('turn-end', 8000);
  await b.expect('turn-end', 8000);
  a2.close(); b.close();
}

async function testReconnectPreservesOppLocked(){
  // Opponent locks in first; we then bounce; resume should report oppLocked=true.
  const { a, b, matchA } = await newMatch();
  const oppMatch = { players: matchA.players, role: matchA.role === 'us' ? 'them' : 'us' };
  submitNoOpAims(b, oppMatch);
  await a.expect('opponent-locked');
  a.close();
  await sleep(150);
  const a2 = new TestClient(a.username);
  await a2.open();
  a2.hello();
  await a2.expect('welcome');
  const resumed = await a2.expect('match-start', 3000);
  if (resumed.oppLocked !== true){
    throw new Error(`opp had locked but oppLocked=${resumed.oppLocked}`);
  }
  if (resumed.iLocked !== false){
    throw new Error(`I haven't locked yet but iLocked=${resumed.iLocked}`);
  }
  a2.close(); b.close();
}

// Force a clash between p10 (us striker) and p5 (them striker) by giving both
// movements that bring them into contact in the middle of the field.
function aimsForcingClash(matchStart, opponent){
  const aims = {};
  const myTeam = matchStart.role === 'us' ? 'us' : 'them';
  const players = matchStart.players || {};
  for (const id of Object.keys(players)){
    if (players[id].team !== myTeam) continue;
    aims[id] = null;
  }
  // Replace striker with a move toward (270, 400) — collision spot.
  if (myTeam === 'us') aims['p10'] = { x: 270, y: 400 };
  else                  aims['p5']  = { x: 270, y: 400 };
  return { aims, ballAim: null, mode: 'kick' };
}

async function testClashFullFlow(){
  const { a, b, matchA, matchB } = await newMatch();
  const aMatch = matchA;
  const bMatch = matchB;
  a.send({ type: 'aims', ...aimsForcingClash(aMatch) });
  b.send({ type: 'aims', ...aimsForcingClash(bMatch) });
  // Both should receive clash-start with the same ctx.
  const cA = await a.expect('clash-start', 5000);
  const cB = await b.expect('clash-start', 5000);
  if (!cA.ctx || !cB.ctx) throw new Error('clash-start missing ctx');
  if (cA.ctx.moverId !== cB.ctx.moverId || cA.ctx.opponentId !== cB.ctx.opponentId){
    throw new Error('clash ctx differs between clients');
  }
  // Both submit 3 QTE scores. Server expects round in 1..3.
  for (let round = 1; round <= 3; round++){
    a.send({ type: 'qte-score', round, score: 50 });
    b.send({ type: 'qte-score', round, score: 50 });
  }
  // Each side should receive opp-qte-score events; eventually clash-outcome.
  const outA = await a.expect('clash-outcome', 5000);
  const outB = await b.expect('clash-outcome', 5000);
  if (!outA.outcome || !outB.outcome) throw new Error('clash-outcome missing outcome');
  // Each side dismisses; server should broadcast clash-dismiss to both.
  a.send({ type: 'clash-dismiss' });
  b.send({ type: 'clash-dismiss' });
  await a.expect('clash-dismiss', 3000);
  await b.expect('clash-dismiss', 3000);
  a.close(); b.close();
}

async function testReconnectMidClash(){
  // Trigger a clash, then bounce one side's WS BEFORE submitting any scores.
  // The resume payload should include `clash` so the new client knows.
  const { a, b, matchA, matchB } = await newMatch();
  a.send({ type: 'aims', ...aimsForcingClash(matchA) });
  b.send({ type: 'aims', ...aimsForcingClash(matchB) });
  await a.expect('clash-start', 5000);
  await b.expect('clash-start', 5000);
  // A bounces during the clash, before any scores are submitted.
  a.close();
  await sleep(150);
  const a2 = new TestClient(a.username);
  await a2.open();
  a2.hello();
  await a2.expect('welcome');
  const resumed = await a2.expect('match-start', 3000);
  if (!resumed.clash || !resumed.clash.ctx){
    throw new Error('resume during clash missing clash info — opponent would be stuck');
  }
  if (resumed.clash.resolved){
    throw new Error('clash should not be resolved yet — no scores submitted');
  }
  a2.close(); b.close();
}

async function testConcurrentQuits(){
  // Both players quit at the same time. Both should get a clean match-end,
  // server shouldn't crash, no second message about the other quitting.
  const { a, b } = await newMatch();
  a.send({ type: 'match-quit' });
  b.send({ type: 'match-quit' });
  await a.expect('match-end', 2000);
  await b.expect('match-end', 2000);
  await a.expectQuiet('match-end', 300);
  await b.expectQuiet('match-end', 300);
  a.close(); b.close();
}

async function testCancelQueueAndRequeue(){
  // A queues, cancels, queues again — should still pair when B arrives.
  const a = new TestClient(uniq('rq-a'));
  const b = new TestClient(uniq('rq-b'));
  await a.open(); await b.open();
  a.hello(); b.hello();
  await a.expect('welcome'); await b.expect('welcome');
  a.send({ type: 'queue' });
  await a.expect('queued');
  a.send({ type: 'cancel-queue' });
  await a.expect('queue-cancelled');
  a.send({ type: 'queue' });
  await a.expect('queued');
  b.send({ type: 'queue' });
  const ms1 = await a.expect('match-start', 2000);
  const ms2 = await b.expect('match-start', 2000);
  if (ms1.matchId !== ms2.matchId) throw new Error('re-queue produced mismatched matches');
  a.close(); b.close();
}

async function testHeartbeatKeepsConnectionAlive(){
  // Open a client, wait ~30s with no activity, then send a queue and confirm
  // the connection is still alive. (The server pings every 25s.)
  const a = new TestClient(uniq('hb'));
  await a.open();
  a.hello();
  await a.expect('welcome');
  // Idle wait — well within Render's ~110s LB timeout, but verifies the
  // server's pings don't disrupt the client.
  await sleep(28000);
  if (a.closed) throw new Error('WS dropped during 28s idle period');
  a.send({ type: 'queue' });
  await a.expect('queued', 2000);
  a.send({ type: 'cancel-queue' });
  await a.expect('queue-cancelled', 2000);
  a.close();
}

async function testAimsWithoutMatch(){
  // Send aims when not in a match — server should not crash, no broadcast.
  const a = new TestClient(uniq('noom'));
  await a.open();
  a.hello();
  await a.expect('welcome');
  a.send({ type: 'aims', aims: {}, ballAim: null, mode: 'kick' });
  // No expected response. Just confirm the server is still alive by
  // sending a queue and getting a queued ack.
  a.send({ type: 'queue' });
  await a.expect('queued', 2000);
  a.send({ type: 'cancel-queue' });
  await a.expect('queue-cancelled', 2000);
  a.close();
}

// ── Runner ──────────────────────────────────────────────────────────────────
const SCENARIOS = [
  ['hello: basic welcome',                            testHelloBasic],
  ['hello: empty username returns error',             testHelloEmptyUsername],
  ['matchmaking: queue pairs two clients',            testMatchmaking],
  ['turn: full happy-path turn completes',            testOneTurnHappyPath],
  ['quit: match-quit ends match correctly',           testQuitDuringMatch],
  ['lock-in: double-submit does not advance',         testLockInIdempotency],
  ['reconnect: same user resumes match',              testReconnectResume],
  ['reconnect: resume preserves lock-in state',       testReconnectPreservesLockIn],
  ['reconnect: resume preserves oppLocked state',     testReconnectPreservesOppLocked],
  ['session-replaced: match survives takeover',       testSessionReplacedDoesntKillMatch],
  ['clash: full QTE flow on both sides',              testClashFullFlow],
  ['clash: reconnect mid-clash includes resume info', testReconnectMidClash],
  ['quit: concurrent quits do not crash',             testConcurrentQuits],
  ['queue: cancel then re-queue still pairs',         testCancelQueueAndRequeue],
  ['heartbeat: 28s idle does not drop connection',    testHeartbeatKeepsConnectionAlive],
  ['invite: accept creates no-keys match',            testInviteFlowNoKeys],
  ['aims without match: no crash',                    testAimsWithoutMatch]
];

async function main(){
  console.log('Starting server on port ' + PORT + '...');
  await startServer();
  console.log('Server ready. Running ' + SCENARIOS.length + ' scenarios.\n');

  const results = [];
  for (const [name, fn] of SCENARIOS){
    const t0 = Date.now();
    try {
      await fn();
      const ms = Date.now() - t0;
      console.log(`PASS  ${name} (${ms}ms)`);
      results.push({ name, ok: true, ms });
    } catch (e){
      const ms = Date.now() - t0;
      console.log(`FAIL  ${name} (${ms}ms)\n      ${e.message}`);
      results.push({ name, ok: false, ms, err: e });
    }
  }

  const passed = results.filter(r => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n${passed} passed, ${failed} failed`);

  if (failed > 0){
    console.log('\n--- failure details ---');
    for (const r of results){
      if (!r.ok){
        console.log(`\n${r.name}`);
        console.log(r.err.stack || r.err.message);
      }
    }
  }

  stopServer();
  process.exit(failed > 0 ? 1 : 0);
}

process.on('SIGINT', () => { stopServer(); process.exit(2); });
process.on('SIGTERM', () => { stopServer(); process.exit(2); });

main().catch((e) => {
  console.error('Harness crashed:', e);
  stopServer();
  process.exit(2);
});
