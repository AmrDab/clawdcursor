// Minimal Express test — does the port actually stay open?
const express = require('express');
const app = express();
app.get('/health', (req, res) => res.json({ ok: true }));
const server = app.listen(3852, '127.0.0.1', () => {
  console.log('MINIMAL: listening on 3852');
  console.log('server.listening =', server.listening);
  console.log('server.address() =', JSON.stringify(server.address()));
});
server.on('error', (e) => console.error('SERVER ERROR:', e));
server.on('close', () => console.log('SERVER CLOSED'));
process.on('exit', (c) => console.log('PROCESS EXIT:', c));
process.on('beforeExit', (c) => console.log('BEFORE EXIT:', c));
