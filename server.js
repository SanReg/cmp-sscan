require('dotenv').config();
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const API_BASE = 'https://nwlguwssyxjpjddolsvl.supabase.co/functions/v1';
const AUTH = { Authorization: `Bearer ${process.env.BEARER_TOKEN}` };

let running = false;
const active = new Set(); // order ids currently being processed
const MAX_CONCURRENT = 5;
const addLog = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

let ordersCol, usersCol;
let startedAt = null; // only orders created after toggle-on are picked up

async function refundOrder(order) {
  // claim the refund atomically so it can never run twice for one order
  const claimed = await ordersCol.updateOne(
    { _id: order._id, refundedAt: { $in: [null] } },
    { $set: { refundAmount: order.checksUsed || 0, refundedAt: new Date() } }
  );
  if (!claimed.modifiedCount) return;

  const userId = order.user;
  if (order.regularChecksUsed > 0) {
    await usersCol.updateOne({ _id: userId }, { $inc: { checks: order.regularChecksUsed } });
    addLog(`refunded ${order.regularChecksUsed} regular check(s) to user ${userId}`);
  }
  if (order.dailyCreditsUsed > 0) {
    // pipeline update so usedToday never goes below 0 (e.g. after a daily reset)
    await usersCol.updateOne({ _id: userId }, [
      { $set: { 'unlimitedSettings.dailyCreditsUsedToday': { $max: [0, { $subtract: [{ $ifNull: ['$unlimitedSettings.dailyCreditsUsedToday', 0] }, order.dailyCreditsUsed] }] } } },
    ]);
    addLog(`refunded ${order.dailyCreditsUsed} daily credit(s) to user ${userId}`);
  }
  for (const lot of order.creditLotsUsed || []) {
    await usersCol.updateOne(
      { _id: userId, 'creditLots._id': new ObjectId(String(lot.lotId)) },
      { $inc: { 'creditLots.$.remaining': lot.amount } }
    );
    addLog(`refunded ${lot.amount} expiring credit(s) to lot ${lot.lotId} of user ${userId}`);
  }
}

async function apiUpload(buf, filename) {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), filename);
  fd.append('excludeQuotes', 'true');
  const res = await fetch(`${API_BASE}/api-documents`, { method: 'POST', headers: AUTH, body: fd });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.orderId) throw new Error(`api-documents failed (${res.status}): ${JSON.stringify(body)}`);
  return body.orderId;
}

async function apiGet(id) {
  const res = await fetch(`${API_BASE}/api-document-get?id=${id}`, { headers: AUTH });
  if (!res.ok) throw new Error(`api-document-get failed (${res.status})`);
  return res.json();
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function uploadToCloudinary(buf, filename) {
  const r = await cloudinary.uploader.upload(
    `data:application/pdf;base64,${buf.toString('base64')}`,
    { folder: 'ecommerce-orders', public_id: filename, resource_type: 'auto' }
  );
  return { filename, url: r.secure_url, public_id: r.public_id, uploadedAt: new Date() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => Date.now();

async function processOrder(order) {
  const id = String(order._id);
  addLog(`processing order ${id} (${order.userFile.filename})`);
  try {
    const fileBuf = await download(order.userFile.url);
    const apiOrderId = await apiUpload(fileBuf, order.userFile.filename);

    let doc;
    while (true) {
      await sleep(30000);
      doc = await apiGet(apiOrderId);
      if (['completed', 'error', 'failed_invalid'].includes(doc.status)) break;
    }
    if (doc.status !== 'completed') {
      throw new Error(`check API returned status "${doc.status}"${doc.error ? ': ' + doc.error : ''}`);
    }

    const base = order.userFile.filename.replace(/\.[^.]+$/, '');
    const [aiBuf, simBuf] = await Promise.all([
      download(doc.reports.ai.downloadUrl),
      download(doc.reports.similarity.downloadUrl),
    ]);
    const [aiReport, similarityReport] = await Promise.all([
      uploadToCloudinary(aiBuf, `${base}_ai_${stamp()}.pdf`),
      uploadToCloudinary(simBuf, `${base}_similarity_${stamp()}.pdf`),
    ]);

    await ordersCol.updateOne(
      { _id: order._id },
      { $set: { status: 'completed', completedAt: new Date(), failureReason: null, processingAt: null, adminFiles: { aiReport, similarityReport } } }
    );
    addLog(`order ${id} completed`);
  } catch (err) {
    addLog(`order ${id} FAILED: ${err.message}`);
    await ordersCol.updateOne(
      { _id: order._id },
      { $set: { status: 'failed', failureReason: err.message, processingAt: null } }
    ).catch((e) => addLog(`could not mark failed: ${e.message}`));
    await refundOrder(order).catch((e) => addLog(`refund failed for order ${id}: ${e.message}`));
  } finally {
    active.delete(id);
  }
}

// Claims one order atomically so two concurrent workers can never grab the same
// one. processingAt is our own field, so `status` keeps the meaning the rest of
// the app expects (pending until it really is completed/failed).
async function claimOrder() {
  const res = await ordersCol.findOneAndUpdate(
    {
      status: 'pending',
      'userFile.url': { $exists: true },
      createdAt: { $gt: startedAt },
      processingAt: { $in: [null] },
    },
    { $set: { processingAt: new Date() } },
    { sort: { createdAt: 1 } }
  );
  return res && res.value !== undefined ? res.value : res; // driver v5 vs v6+ shape
}

async function workerLoop() {
  while (running) {
    try {
      while (running && active.size < MAX_CONCURRENT) {
        const order = await claimOrder();
        if (!order) break;
        const id = String(order._id);
        active.add(id);
        // deliberately not awaited: that is what makes them run in parallel
        processOrder(order).catch((e) => {
          active.delete(id);
          addLog(`order ${id} crashed: ${e.message}`);
        });
      }
    } catch (err) {
      addLog(`worker error: ${err.message}`);
    }
    await sleep(5000);
  }
  addLog('worker stopped');
}

const app = express();
// ponytail: open CORS so other sites can call /api/*; lock to an origin allowlist if abuse ever matters
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static('public'));

app.get('/api/status', (req, res) => res.json({ running, active: [...active] }));

app.get('/health', async (req, res) => {
  try {
    await ordersCol.findOne({}, { projection: { _id: 1 } }); // proves db is reachable
    res.json({ status: 'ok', running, active: [...active], uptime: process.uptime() });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
});

app.post('/api/toggle', (req, res) => {
  running = !running;
  if (running) {
    startedAt = new Date();
    addLog(`worker started, watching for orders created after ${startedAt.toISOString()}`);
    workerLoop();
  }
  res.json({ running });
});

async function connect() {
  const client = await MongoClient.connect(process.env.MONGODB_URI);
  const db = client.db(); // db name comes from MONGODB_URI (.env)
  ordersCol = db.collection('orders');
  usersCol = db.collection('users');
  return client;
}

if (require.main === module) {
  connect().then(() => app.listen(3000, () => console.log('http://localhost:3000')));
}

module.exports = { connect, refundOrder };
