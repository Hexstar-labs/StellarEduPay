# Stellar Blockchain Integration Guide

A technical guide to how StellarEduPay integrates with the Stellar network for school fee collection.

## Overview

StellarEduPay uses the **Stellar SDK** (`@stellar/stellar-sdk`) to:
1. **Receive** school fee payments via Stellar transactions
2. **Verify** payment validity using on-chain data
3. **Track** payment status with ledger confirmations
4. **Identify** students via encrypted memos

---

## Core Concepts

### Assets

The system accepts:
- **XLM** (Stellar's native asset, `asset_type: "native"`)
- **Stellar-compatible tokens** (USDC, other issued assets)

Detection function in `stellarService.js`:
```javascript
function detectAsset(payOp) {
  const assetType = payOp.asset_type;
  const assetCode = assetType === 'native' ? 'XLM' : payOp.asset_code;
  const { accepted } = isAcceptedAsset(assetCode, assetType);
  if (!accepted) return null;
  return { assetCode, assetType, assetIssuer: payOp.asset_issuer };
}
```

### Memos — Student Identification

Every payment **must** include a **memo** — a short text identifier that maps the payment to a student.

- Students pay to the school's Stellar wallet address
- The memo field contains the **student ID** (e.g., `"STU-001"`)
- Memo collision detection prevents payments from being misattributed

```javascript
const rawMemo = tx.memo ? tx.memo.trim() : null;
if (!rawMemo) {
  throw Object.assign(new Error('Missing memo'), { code: 'MISSING_MEMO' });
}
const memo = rawMemo;
```

### Transaction Flow

```
Student initiates payment
        |
        v
Backend generates PaymentIntent with memo
        |
        v
Student sends XLM/tokens to school wallet with memo
        |
        v
Backend polls Stellar Horizon API (transactionPollingService)
        |
        v
Transaction verified:
  - Is it successful? (tx.successful)
  - Does it target the school wallet?
  - Is the memo valid?
  - Is the asset supported?
        |
        v
Payment recorded in MongoDB (Payment collection)
        |
        v
Ledger confirmations tracked (CONFIRMATION_THRESHOLD)
        |
        v
Payment confirmed when ledger_sequence confirms
```

---

## Key Operations

### 1. Verifying a Transaction

**File:** `stellarService.js` → `verifyTransaction(txHash, walletAddress)`

```javascript
async function verifyTransaction(txHash, walletAddress) {
  // 1. Fetch transaction from Stellar Horizon
  const tx = await server.transactions().transaction(txHash).call();

  // 2. Check transaction success
  if (!tx.successful) {
    throw Object.assign(new Error('Transaction failed'), { code: 'TX_FAILED' });
  }

  // 3. Extract memo
  const rawMemo = tx.memo ? tx.memo.trim() : null;
  if (!rawMemo) {
    throw Object.assign(new Error('Missing memo'), { code: 'MISSING_MEMO' });
  }
  const memo = rawMemo;

  // 4. Find payment operation targeting school wallet
  const ops = await tx.operations();
  const payOp = ops.records.find(
    op => op.type === 'payment' && op.to === walletAddress
  );
  if (!payOp) {
    throw Object.assign(new Error('Invalid destination'), { code: 'INVALID_DESTINATION' });
  }

  // 5. Validate asset
  const asset = detectAsset(payOp);
  if (!asset) {
    throw Object.assign(new Error('Unsupported asset'), { code: 'UNSUPPORTED_ASSET' });
  }

  // 6. Normalize amount (Stellar uses string amounts)
  const amount = normalizeAmount(payOp.amount);

  // 7. Source account validation (anti-fraud)
  const sourceValidation = await validateSourceAccount(payOp.from, schoolId, new Date(tx.created_at));

  return { hash: tx.hash, memo, amount, assetCode: asset.assetCode, sourceAccount: payOp.from };
}
```

**Error codes:**

| Code | Meaning |
|------|---------|
| `TX_FAILED` | Transaction failed on Stellar network |
| `MISSING_MEMO` | No memo in transaction — cannot identify student |
| `INVALID_DESTINATION` | Payment not to school's wallet |
| `UNSUPPORTED_ASSET` | Asset not in accepted list |
| `INVALID_SOURCE` | Source account failed validation (blacklist/whitelist) |

### 2. Polling for Incoming Payments

**File:** `stellarService.js` → `syncPaymentsForSchool(school)`

```javascript
async function syncPaymentsForSchool({ schoolId, stellarAddress }) {
  // Fetch last 20 transactions for school wallet
  const transactions = await server.transactions()
    .forAccount(stellarAddress)
    .order('desc')
    .limit(20)
    .call();

  for (const tx of transactions.records) {
    // Skip already-recorded transactions
    if (await Payment.findOne({ txHash: tx.hash })) continue;

    // Parse and validate transaction
    const valid = await extractValidPayment(tx, stellarAddress);
    if (!valid) continue; // Not a valid payment for this school

    const { payOp, memo } = valid;
    const student = await Student.findOne({ studentId: memo });
    const intent = await PaymentIntent.findOne({ schoolId, memo, status: 'pending' });

    // Run fraud detection
    const [collision, abnormal] = await Promise.all([
      detectMemoCollision(memo, payOp.from, paymentAmount, feeAmount, txDate, schoolId),
      detectAbnormalPatterns(payOp.from, paymentAmount, feeAmount, txDate, schoolId)
    ]);

    const isSuspicious = collision.suspicious || abnormal.suspicious;

    // Check ledger confirmations
    const isConfirmed = txLedger ? await checkConfirmationStatus(txLedger) : false;

    // Record payment
    await Payment.create({
      schoolId, studentId: student._id,
      txHash: tx.hash, amount: paymentAmount,
      status: isConfirmed && !isSuspicious ? 'SUCCESS' : 'PENDING',
      memo, senderAddress: payOp.from,
      isSuspicious, suspicionReason: [collision.reason, abnormal.reason].filter(Boolean).join('; '),
      confirmationStatus: isConfirmed ? 'confirmed' : 'pending_confirmation',
      ledgerSequence: txLedger
    });
  }
}
```

### 3. Checking Ledger Confirmations

Stellar uses a **ledger-based confirmation** system. A transaction is considered "confirmed" after `CONFIRMATION_THRESHOLD` ledgers have passed (typically 1-2).

```javascript
const CONFIRMATION_THRESHOLD = 1; // in stellarConfig.js

async function checkConfirmationStatus(txLedger) {
  const latestLedger = await server.ledgers().order('desc').limit(1).call();
  const latestSequence = latestLedger.records[0].sequence;
  return (latestSequence - txLedger) >= CONFIRMATION_THRESHOLD;
}
```

### 4. Dynamic Fee Calculation

The system calculates fees dynamically based on student/school fee structures:

```javascript
async function getAdjustedFee(student, intentAmount, paymentDate, schoolId) {
  const feeStructure = await FeeStructure.findOne({
    schoolId,
    className: student.class || student.className,
    academicYear: student.academicYear
  });

  const baseFee = feeStructure ? feeStructure.feeAmount : (student.feeAmount || intentAmount || 0);

  const context = {
    userId: student._id,
    userType: 'student',
    baseAmount: baseFee,
    paymentType: 'course',
    timestamp: paymentDate
  };

  const result = feeEngine.calculateFee(context);
  return { baseFee: result.baseFee, finalFee: result.finalFee, adjustmentsApplied: result.adjustments };
}
```

### 5. Memo Collision Detection

Prevents two different senders from using the same memo within 24 hours (potential fraud):

```javascript
async function detectMemoCollision(memo, senderAddress, paymentAmount, expectedFee, txDate, schoolId) {
  const COLLISION_WINDOW_MS = 24 * 60 * 60 * 1000;
  const windowStart = new Date(txDate.getTime() - COLLISION_WINDOW_MS);

  const recentFromOtherSender = await Payment.findOne({
    schoolId, studentId: memo,
    senderAddress: { $ne: senderAddress, $ne: null },
    confirmedAt: { $gte: windowStart }
  });

  if (recentFromOtherSender) {
    return {
      suspicious: true,
      reason: `Memo "${memo}" was used by a different sender within 24 hours`
    };
  }
  return { suspicious: false };
}
```

### 6. Normalizing Amounts

Stellar amounts are strings to avoid floating-point precision errors:

```javascript
function normalizeAmount(rawAmount) {
  return parseFloat(parseFloat(rawAmount).toFixed(7));
}
```

---

## Data Model

### Payment (MongoDB)

```javascript
{
  schoolId: ObjectId,
  studentId: String,           // From memo
  txHash: String,             // Stellar transaction hash (unique)
  amount: Number,             // Normalized amount
  baseFee: Number,            // Original fee
  finalFee: Number,           // After adjustments
  adjustmentsApplied: Array,   // Fee adjustments made
  assetCode: String,          // 'XLM' or token code
  senderAddress: String,       // Stellar public key of sender
  memo: String,               // Decrypted memo
  status: 'SUCCESS' | 'PENDING' | 'FAILED',
  confirmationStatus: 'confirmed' | 'pending_confirmation' | 'failed',
  isSuspicious: Boolean,
  suspicionReason: String | null,
  ledgerSequence: Number,     // Stellar ledger number
  referenceCode: String,      // Internal reference
  confirmedAt: Date
}
```

---

## Rate Limiting

The system uses `stellarRateLimitedClient.js` with `withStellarRetry()` to handle Horizon API rate limits:

```javascript
const { withStellarRetry } = require('../utils/withStellarRetry');

// All Horizon API calls go through retry logic
const tx = await withStellarRetry(
  () => server.transactions().transaction(txHash).call(),
  { label: 'verifyTransaction' }
);
```

---

## Security Features

1. **Source account validation** — blacklist/whitelist/new-sender limits (`SourceValidationRule` model)
2. **Memo collision detection** — prevents payment misattribution
3. **Abnormal pattern detection** — flags unusual payment amounts or frequencies
4. **Duplicate tx prevention** — `DUPLICATE_TX` error on re-submission
6. **Amount validation** — `validatePaymentAmount()` checks for negative/zero amounts

---

## Configuration

**File:** `backend/src/config/stellarConfig.js`

```javascript
module.exports = {
  server: new StellarSdk.HorizonServer('https://horizon.stellar.org', {
    allowHttp: false
  }),
  isAcceptedAsset: (assetCode, assetType) => { /* ... */ },
  CONFIRMATION_THRESHOLD: 1  // ledgers before payment is confirmed
};
```

---

## Adding a New Asset

1. Update `isAcceptedAsset()` in `stellarConfig.js`
2. Add the asset's `asset_code` and `asset_issuer` to the accepted list
3. Ensure the asset has a trustline set up on the school wallet
