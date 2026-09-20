// server.js — Outbreak multiplayer server
// Serves the game page AND relays multiplayer messages over WebSocket.
// This replaces the old PeerJS/Firebase approach entirely: no third-party
// broker, no signup, no billing risk. Just this one process.
//
// Setup:
//   npm install ws
//   node server.js [port]
//
// Then share whatever URL points at this server (e.g. http://<your-ip>:8080
// on a LAN, or a real https:// URL if you deploy this to a host with a
// public address). Everyone who opens that link plays in the same game.

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.argv[2] || process.env.PORT || 8080;
const GAME_FILE = path.join(__dirname, 'zombie_shooter_multiplayer.html');

const ZOMBIE_ROLE_KEYS = ['normal', 'speeder', 'tanker', 'exploder', 'spitter', 'leaper'];

let roster = {};      // id -> { name, roundsAsShooter }
let clients = new Map(); // id -> ws
let nextId = 1;
let game = { state: 'lobby', shooterId: null, roles: {}, round: 0, mazeSeed: 0 };

// ---------- Static file server for the game page itself ----------
const server = http.createServer((req, res) => {
  fs.readFile(GAME_FILE, (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end('Could not load zombie_shooter_multiplayer.html — make sure it is in the same folder as server.js.');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

function broadcast(obj, excludeId) {
  const str = JSON.stringify(obj);
  for (const [id, ws] of clients) {
    if (id === excludeId) continue;
    if (ws.readyState === WebSocket.OPEN) ws.send(str);
  }
}
function sendTo(id, obj) {
  const ws = clients.get(id);
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function startRound() {
  const ids = Object.keys(roster);
  if (ids.length < 2) return;

  let bestCount = Infinity, candidates = [];
  for (const id of ids) {
    const rc = roster[id].roundsAsShooter || 0;
    if (rc < bestCount) { bestCount = rc; candidates = [id]; }
    else if (rc === bestCount) candidates.push(id);
  }
  const shooterId = candidates[Math.floor(Math.random() * candidates.length)];

  const roles = {};
  for (const id of ids) {
    if (id === shooterId) continue;
    roles[id] = ZOMBIE_ROLE_KEYS[Math.floor(Math.random() * ZOMBIE_ROLE_KEYS.length)];
  }

  const mazeSeed = Math.floor(Math.random() * 4294967295);
  game.round += 1;
  roster[shooterId].roundsAsShooter = bestCount + 1;
  game = { state: 'playing', shooterId, roles, mazeSeed, round: game.round };

  broadcast({ type: 'roundStart', shooterId, roles, mazeSeed, round: game.round });
  broadcast({ type: 'roster', players: roster });
  console.log(`Round ${game.round} started. Shooter: ${roster[shooterId].name}`);
}

wss.on('connection', (ws) => {
  const id = 'p' + (nextId++);
  clients.set(id, ws);
  ws.send(JSON.stringify({ type: 'welcome', id }));

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch (e) { return; }

    switch (data.type) {
      case 'hello':
        roster[id] = { name: String(data.name || 'Player').slice(0, 16), roundsAsShooter: 0 };
        broadcast({ type: 'roster', players: roster });
        console.log(`${roster[id].name} joined (${id}). Players: ${Object.keys(roster).length}`);
        break;

      case 'startRoundRequest':
        startRound();
        break;

      case 'zstate':
      case 'ability':
        // only ever meaningful to the current shooter
        data.from = id;
        if (game.shooterId) sendTo(game.shooterId, data);
        break;

      case 'state':
        // the shooter's authoritative broadcast — relay to everyone else
        data.from = id;
        broadcast(data, id);
        break;

      case 'roundOver':
        data.from = id;
        game.state = 'roundover';
        broadcast(data, id);
        break;
    }
  });

  ws.on('close', () => {
    clients.delete(id);
    const wasShooter = (id === game.shooterId);
    delete roster[id];
    broadcast({ type: 'roster', players: roster });
    if (wasShooter && game.state === 'playing') {
      game.state = 'roundover';
      broadcast({ type: 'roundOver', result: 'zombies', reason: 'shooter-disconnected' });
      console.log('Shooter disconnected mid-round — round ended.');
    }
    console.log(`Player disconnected (${id}). Players: ${Object.keys(roster).length}`);
  });

  ws.on('error', (e) => console.error('WS error for', id, e.message));
});

server.listen(PORT, () => {
  console.log(`Outbreak server running at http://localhost:${PORT}`);
  console.log(`On your LAN, others can join at http://<your-local-ip>:${PORT}`);
  console.log(`For internet-wide play, deploy this to a host with a public address and share that URL instead.`);
});
