const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static("public"));

// roomId -> { url, playing, position, updatedAt, members: Map(socketId -> name) }
const rooms = new Map();
const getRoom = (id) => {
  if (!rooms.has(id)) rooms.set(id, { url: "", playing: false, position: 0, updatedAt: Date.now(), members: new Map() });
  return rooms.get(id);
};
const publicState = (r) => ({ url: r.url, playing: r.playing, position: r.position, updatedAt: r.updatedAt });
const sendUsers = (id, r) => io.to(id).emit("users", [...r.members.values()]);

io.on("connection", (socket) => {
  let roomId = null;

  // Clock sync: client sends its time, server replies with server time
  socket.on("time", (cb) => cb(Date.now()));

  socket.on("join", ({ room, name }) => {
    roomId = String(room).slice(0, 40);
    const r = getRoom(roomId);
    socket.join(roomId);
    r.members.set(socket.id, String(name || "Guest").slice(0, 24));
    socket.emit("state", publicState(r));   // late joiner catches up
    sendUsers(roomId, r);
    io.to(roomId).emit("chat", { system: true, text: `${r.members.get(socket.id)} joined` });
  });

  socket.on("set-url", (url) => {
    const r = rooms.get(roomId); if (!r) return;
    Object.assign(r, { url: String(url).slice(0, 2000), playing: false, position: 0, updatedAt: Date.now() });
    io.to(roomId).emit("state", publicState(r));
  });

  // play / pause / seek: { playing, position }
  socket.on("control", ({ playing, position }) => {
    const r = rooms.get(roomId); if (!r) return;
    Object.assign(r, { playing: !!playing, position: Number(position) || 0, updatedAt: Date.now() });
    socket.to(roomId).emit("state", publicState(r));
  });

  socket.on("chat", (text) => {
    const r = rooms.get(roomId); if (!r) return;
    io.to(roomId).emit("chat", { name: r.members.get(socket.id), text: String(text).slice(0, 500) });
  });

  socket.on("disconnect", () => {
    const r = rooms.get(roomId); if (!r) return;
    const name = r.members.get(socket.id);
    r.members.delete(socket.id);
    if (r.members.size === 0) rooms.delete(roomId);
    else { sendUsers(roomId, r); io.to(roomId).emit("chat", { system: true, text: `${name} left` }); }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`WatchParty running on http://localhost:${PORT}`));
