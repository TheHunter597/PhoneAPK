// (routes/sse.js) Implements Server-Sent Events (SSE) for real-time communication with clients. Maintains a list of connected clients and provides a function to broadcast events to all clients. Clients can connect to the /events endpoint to receive updates, and the server will handle client disconnections gracefully.

const express = require("express");
const router = express.Router();

let sseClients = [];

router.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("retry: 10000\n\n");

  const clientId = Date.now();
  const newClient = { id: clientId, res };
  sseClients.push(newClient);

  req.on("close", () => {
    sseClients = sseClients.filter((c) => c.id !== clientId);
  });
});

function broadcastSSE(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((client) => {
    try {
      client.res.write(message);
    } catch (err) {
      sseClients = sseClients.filter((c) => c.id !== client.id);
    }
  });
}

module.exports = {
  router,
  broadcastSSE,
};
