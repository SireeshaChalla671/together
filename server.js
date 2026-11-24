const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const VERSION = "v5";
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static("public", { etag: false, maxAge: 0 })); // no caching while developing

const rooms = new Map();
const getRoom = (id) => {
  if (!rooms.has(id)) rooms.set(id, {
    url: "", playing: false, position: 0, updatedAt: Date.now(),
    resumeAfter: false, hostId: null, hostOnly: false,
    members: new Map(), waiting: new Set(), voice: new Set(), holdTimer: null,
  });
  return rooms.get(id);
};
const publicState = (r) => ({ url: r.url, playing: r.playing, position: r.position, updatedAt: r.updatedAt });
const currentPos = (r) => r.position + (r.playing ? (Date.now() - r.updatedAt) / 1000 : 0);
const sendUsers = (id, r) => io.to(id).emit("users", [...r.members.values()]);
const sendRoom = (id, r) => io.to(id).emit("room", { hostId: r.hostId, hostOnly: r.hostOnly });
const canControl = (socket, r) => !r.hostOnly || r.hostId === socket.id;
const deny = (socket, r) => {
  socket.emit("chat", { system: true, text: "Only the host can do that right now" });
  socket.emit("state", publicState(r));
};

function updateWait(id, r) {
  io.to(id).emit("wait", { names: [...r.waiting].map((s) => r.members.get(s)).filter(Boolean) });
  if (r.waiting.size === 0) {
    clearTimeout(r.holdTimer);
    if (r.resumeAfter) {
      r.resumeAfter = false;
      Object.assign(r, { playing: true, updatedAt: Date.now() });
      io.to(id).emit("state", publicState(r));
    }
  }
}

io.on("connection", (socket) => {
  let roomId = null;
  socket.emit("hello", { version: VERSION });
  socket.on("time", (cb) => cb(Date.now()));

  socket.on("join", ({ room, name }) => {
    roomId = String(room).slice(0, 40);
    const r = getRoom(roomId);
    socket.join(roomId);
    r.members.set(socket.id, String(name || "Guest").slice(0, 24));
    if (!r.hostId || !r.members.has(r.hostId)) r.hostId = socket.id;
    socket.emit("state", publicState(r));
    sendUsers(roomId, r);
    sendRoom(roomId, r);
    io.to(roomId).emit("chat", { system: true, text: `${r.members.get(socket.id)} joined` });
  });

  socket.on("set-url", (url) => {
    const r = rooms.get(roomId); if (!r) return;
    if (!canControl(socket, r)) return deny(socket, r);
    Object.assign(r, { url: String(url).slice(0, 2000), playing: false, position: 0, updatedAt: Date.now(), resumeAfter: false });
    io.to(roomId).emit("state", publicState(r));
  });

  socket.on("control", ({ playing, position }) => {
    const r = rooms.get(roomId); if (!r) return;
    if (!canControl(socket, r)) return deny(socket, r);
    r.resumeAfter = false;
    Object.assign(r, { playing: !!playing, position: Number(position) || 0, updatedAt: Date.now() });
    socket.to(roomId).emit("state", publicState(r));
  });

  socket.on("buffering", (isBuffering) => {
    const r = rooms.get(roomId); if (!r) return;
    if (isBuffering) {
      if (r.waiting.has(socket.id)) return;
      r.waiting.add(socket.id);
      if (r.playing) {
        Object.assign(r, { position: currentPos(r), playing: false, updatedAt: Date.now(), resumeAfter: true });
        io.to(roomId).emit("state", publicState(r));
        clearTimeout(r.holdTimer);
        r.holdTimer = setTimeout(() => { r.waiting.clear(); updateWait(roomId, r); }, 15000);
      }
    } else r.waiting.delete(socket.id);
    updateWait(roomId, r);
  });

  socket.on("set-host-only", (flag) => {
    const r = rooms.get(roomId); if (!r || r.hostId !== socket.id) return;
    r.hostOnly = !!flag;
    sendRoom(roomId, r);
    io.to(roomId).emit("chat", { system: true, text: r.hostOnly ? "Host-only control is ON" : "Everyone can control playback" });
  });

  // ---- chat (accepts plain text or { room, name, text }) ----
  socket.on("chat", (msg, ack) => {
    const reply = (o) => typeof ack === "function" && ack(o);
    const isObj = msg && typeof msg === "object";
    const room = String((isObj && msg.room) || roomId || "").slice(0, 40);
    const text = String(isObj ? msg.text : msg || "").trim().slice(0, 500);
    const r = rooms.get(roomId);
    const name = String((isObj && msg.name) || (r && r.members.get(socket.id)) || "Guest").slice(0, 24);
    if (!room || !text) return reply({ ok: false });
    if (!socket.rooms.has(room)) socket.join(room);
    console.log(`[chat] room=${room} ${name}: ${text}`);
    io.to(room).emit("chat", { name, text });
    reply({ ok: true });
  });

  // ---- voice calling: the server only relays signaling, audio goes peer-to-peer ----
  socket.on("voice-join", () => {
    const r = rooms.get(roomId); if (!r) return;
    const others = [...r.voice].filter((id) => id !== socket.id);
    r.voice.add(socket.id);
    socket.emit("voice-peers", others.map((id) => ({ id, name: r.members.get(id) })));
    io.to(roomId).emit("chat", { system: true, text: `🎤 ${r.members.get(socket.id)} joined voice` });
  });

  socket.on("voice-leave", () => {
    const r = rooms.get(roomId); if (!r || !r.voice.has(socket.id)) return;
    r.voice.delete(socket.id);
    socket.to(roomId).emit("voice-left", socket.id);
    io.to(roomId).emit("chat", { system: true, text: `🔇 ${r.members.get(socket.id)} left voice` });
  });

  socket.on("signal", ({ to, data }) => {
    const r = rooms.get(roomId); if (!r || !r.members.has(to)) return;
    io.to(to).emit("signal", { from: socket.id, name: r.members.get(socket.id), data });
  });

  socket.on("disconnect", () => {
    const r = rooms.get(roomId); if (!r) return;
    const name = r.members.get(socket.id);
    if (r.voice.delete(socket.id)) socket.to(roomId).emit("voice-left", socket.id);
    r.members.delete(socket.id);
    r.waiting.delete(socket.id);
    if (r.members.size === 0) { clearTimeout(r.holdTimer); rooms.delete(roomId); return; }
    if (r.hostId === socket.id) r.hostId = [...r.members.keys()][0];
    sendUsers(roomId, r); sendRoom(roomId, r); updateWait(roomId, r);
    io.to(roomId).emit("chat", { system: true, text: `${name} left` });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Together ${VERSION} running on http://localhost:${PORT}`));