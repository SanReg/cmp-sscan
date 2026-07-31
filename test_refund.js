// ponytail: smallest check that fails if refund logic breaks. Run: node test_refund.js
require('dotenv').config();
const assert = require('assert');
const { ObjectId } = require('mongodb');
const { connect, refundOrder } = require('./server');

(async () => {
  const client = await connect();
  const db = client.db();
  const users = db.collection('users');
  const orders = db.collection('orders');

  const lotId = new ObjectId();
  const { insertedId: userId } = await users.insertOne({
    username: '__refund_test__',
    checks: 10,
    unlimitedSettings: { dailyCreditsUsedToday: 3 },
    creditLots: [{ _id: lotId, amount: 5, remaining: 2, expiresAt: new Date() }],
  });
  const { insertedId: orderId } = await orders.insertOne({
    user: userId,
    status: 'failed',
    checksUsed: 4,
    regularChecksUsed: 2,
    dailyCreditsUsed: 1,
    expiringChecksUsed: 1,
    creditLotsUsed: [{ lotId, amount: 1 }],
    createdAt: new Date(),
  });

  try {
    const order = await orders.findOne({ _id: orderId });
    await refundOrder(order);
    await refundOrder(order); // second call must be a no-op (double-refund guard)

    const u = await users.findOne({ _id: userId });
    const o = await orders.findOne({ _id: orderId });
    assert.strictEqual(u.checks, 12, 'regular checks refunded once');
    assert.strictEqual(u.unlimitedSettings.dailyCreditsUsedToday, 2, 'daily usage decremented once');
    assert.strictEqual(u.creditLots[0].remaining, 3, 'lot remaining refunded once');
    assert.strictEqual(o.refundAmount, 4, 'refundAmount set');
    assert.ok(o.refundedAt instanceof Date, 'refundedAt set');
    console.log('refund test PASSED');
  } finally {
    await users.deleteOne({ _id: userId });
    await orders.deleteOne({ _id: orderId });
    await client.close();
  }
})();
