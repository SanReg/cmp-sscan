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

const SH_BASE = 'https://api.scribehub.work/api/v1';
const SH_AUTH = { Authorization: `Bearer ${process.env.SCRIBE_HUB}` };

const MAX_CONCURRENT = 5;
const addLog = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

let ordersCol, usersCol;

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

async function download(url, headers = {}) {
  const res = await fetch(url, { headers });
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

// --- provider check implementations: take a file, return both report buffers ---

async function similarityScanCheck(buf, filename) {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), filename);
  fd.append('excludeQuotes', 'true');
  const res = await fetch(`${API_BASE}/api-documents`, { method: 'POST', headers: AUTH, body: fd });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.orderId) throw new Error(`api-documents failed (${res.status}): ${JSON.stringify(body)}`);

  let doc;
  while (true) {
    await sleep(30000);
    const r = await fetch(`${API_BASE}/api-document-get?id=${body.orderId}`, { headers: AUTH });
    if (!r.ok) throw new Error(`api-document-get failed (${r.status})`);
    doc = await r.json();
    if (['completed', 'error', 'failed_invalid'].includes(doc.status)) break;
  }
  if (doc.status !== 'completed') {
    throw new Error(`check API returned status "${doc.status}"${doc.error ? ': ' + doc.error : ''}`);
  }
  const aiUrl = doc.reports?.ai?.downloadUrl;
  const simUrl = doc.reports?.similarity?.downloadUrl;
  if (!aiUrl && !simUrl) throw new Error('completed but no reports available');
  const [aiBuf, simBuf] = await Promise.all([
    aiUrl ? download(aiUrl) : null,
    simUrl ? download(simUrl) : null,
  ]);
  return { aiBuf, simBuf };
}

async function scribehubCheck(buf, filename) {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), filename);
  const res = await fetch(`${SH_BASE}/checks`, { method: 'POST', headers: SH_AUTH, body: fd });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.id) throw new Error(`scribehub POST /checks failed (${res.status}): ${JSON.stringify(body)}`);

  let doc;
  while (true) {
    await sleep(30000);
    const r = await fetch(`${SH_BASE}/checks/${body.id}`, { headers: SH_AUTH });
    if (!r.ok) throw new Error(`scribehub GET /checks/${body.id} failed (${r.status})`);
    doc = await r.json();
    if (['completed', 'cancelled'].includes(doc.status)) break;
  }
  if (doc.status !== 'completed') throw new Error(`scribehub returned status "${doc.status}"`);

  if (!doc.ai_report_available && !doc.similarity_report_available) {
    throw new Error('scribehub: completed but no reports available');
  }
  const [aiBuf, simBuf] = await Promise.all([
    doc.ai_report_available ? download(`${SH_BASE}/checks/${body.id}/reports/ai`, SH_AUTH) : null,
    doc.similarity_report_available ? download(`${SH_BASE}/checks/${body.id}/reports/similarity`, SH_AUTH) : null,
  ]);
  return { aiBuf, simBuf };
}

// --- generic worker, one instance per provider ---

const providers = {
  sscan: { name: 'sscan', runCheck: similarityScanCheck, running: false, active: new Set(), startedAt: null },
  scribehub: { name: 'scribehub', runCheck: scribehubCheck, running: false, active: new Set(), startedAt: null },
};

async function processOrder(p, order) {
  const id = String(order._id);
  addLog(`[${p.name}] processing order ${id} (${order.userFile.filename})`);
  try {
    const fileBuf = await download(order.userFile.url);
    const { aiBuf, simBuf } = await p.runCheck(fileBuf, order.userFile.filename);

    const base = order.userFile.filename.replace(/\.[^.]+$/, '');
    const [aiReport, similarityReport] = await Promise.all([
      aiBuf ? uploadToCloudinary(aiBuf, `${base}_ai_${stamp()}.pdf`) : null,
      simBuf ? uploadToCloudinary(simBuf, `${base}_similarity_${stamp()}.pdf`) : null,
    ]);

    const adminFiles = {};
    if (aiReport) adminFiles.aiReport = aiReport;
    if (similarityReport) adminFiles.similarityReport = similarityReport;
    await ordersCol.updateOne(
      { _id: order._id },
      { $set: { status: 'completed', completedAt: new Date(), failureReason: null, processingAt: null, adminFiles } }
    );
    addLog(`[${p.name}] order ${id} completed${aiReport && similarityReport ? '' : ` (only ${aiReport ? 'ai' : 'similarity'} report available)`}`);
  } catch (err) {
    addLog(`[${p.name}] order ${id} FAILED: ${err.message}`);
    await ordersCol.updateOne(
      { _id: order._id },
      { $set: { status: 'failed', failureReason: err.message, processingAt: null } }
    ).catch((e) => addLog(`could not mark failed: ${e.message}`));
    await refundOrder(order).catch((e) => addLog(`refund failed for order ${id}: ${e.message}`));
  } finally {
    p.active.delete(id);
  }
}

// Claims one order atomically so two concurrent workers (even across providers)
// can never grab the same one. processingAt is our own field, so `status` keeps
// the meaning the rest of the app expects.
async function claimOrder(p) {
  const res = await ordersCol.findOneAndUpdate(
    {
      status: 'pending',
      'userFile.url': { $exists: true },
      createdAt: { $gt: p.startedAt },
      processingAt: { $in: [null] },
    },
    { $set: { processingAt: new Date() } },
    { sort: { createdAt: 1 } }
  );
  return res && res.value !== undefined ? res.value : res; // driver v5 vs v6+ shape
}

async function workerLoop(p) {
  while (p.running) {
    try {
      while (p.running && p.active.size < MAX_CONCURRENT) {
        const order = await claimOrder(p);
        if (!order) break;
        const id = String(order._id);
        p.active.add(id);
        // deliberately not awaited: that is what makes them run in parallel
        processOrder(p, order).catch((e) => {
          p.active.delete(id);
          addLog(`[${p.name}] order ${id} crashed: ${e.message}`);
        });
      }
    } catch (err) {
      addLog(`[${p.name}] worker error: ${err.message}`);
    }
    await sleep(5000);
  }
  addLog(`[${p.name}] worker stopped`);
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

function mountRoutes(prefix, p, extraHealth) {
  app.get(`${prefix}/api/status`, (req, res) => res.json({ running: p.running, active: [...p.active] }));

  app.post(`${prefix}/api/toggle`, (req, res) => {
    p.running = !p.running;
    if (p.running) {
      p.startedAt = new Date();
      addLog(`[${p.name}] worker started, watching for orders created after ${p.startedAt.toISOString()}`);
      workerLoop(p);
    }
    res.json({ running: p.running });
  });

  app.get(`${prefix}/health`, async (req, res) => {
    try {
      await ordersCol.findOne({}, { projection: { _id: 1 } }); // proves db is reachable
      const extra = extraHealth ? await extraHealth() : {};
      res.json({ status: 'ok', running: p.running, active: [...p.active], uptime: process.uptime(), ...extra });
    } catch (err) {
      res.status(503).json({ status: 'error', error: err.message });
    }
  });
}

mountRoutes('', providers.sscan);
mountRoutes('/scribehub', providers.scribehub, async () => {
  const r = await fetch(`${SH_BASE}/credit`, { headers: SH_AUTH });
  const c = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`scribehub /credit failed (${r.status})${c.error ? ': ' + c.error : ''}`);
  return { credit: c };
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
