# WholesaleLedger Backend

Node.js 20+ backend for WhatsApp-driven wholesale ledger entries. It receives WhatsApp text, voice notes, and UPI/payment screenshots, extracts ledger data with AI, stores running-balance transactions, and broadcasts live updates to the PWA over SSE.

## What It Does

- Connects to WhatsApp through Baileys and shows QR in the terminal plus `GET /api/qr`.
- Accepts messages only from `TRUSTED_NUMBERS`.
- Transcribes voice notes with Groq Whisper.
- Extracts payment and goods entries from text/transcripts with Gemini.
- Reads UPI/payment screenshots with Gemini 1.5 Flash multimodal.
- Tracks a running balance per client, not strict invoice-by-invoice accounting.
- Blocks confirmed goods entries that exceed credit limit and alerts the owner.
- Calculates behavioral ratings from payment/goods/reminder patterns.
- Runs a daily overdue reminder job at 9 AM.
- Rate-limits Gemini work with `p-queue` at `concurrency=1`, `intervalCap=12`, `interval=60000`.

## Setup

```bash
cd backend
npm install
copy .env.example .env
npm start
```

Important `.env` values:

```text
GEMINI_API_KEY=your_google_ai_studio_key
GROQ_API_KEY=your_groq_key
TRUSTED_NUMBERS=+91OWNER,+91MANAGER
OWNER_NUMBER=91OWNER
BUSINESS_NAME=Your Business Name
BUSINESS_PREFIX=RAM
FRONTEND_URL=https://hackathon-project-bice-tau.vercel.app
```

Scan QR on first run:

```text
WhatsApp > Linked devices > Link a device
```

## Running Balance Rules

- Goods: `running_balance += goods_amount`, `last_goods_date = today`, `due_date = today + payment_cycle_days`.
- Payment: `running_balance -= payment_amount`, clamped to `0`; payment does not change `due_date`.
- New goods with old balance carries old balance forward and resets due date.
- If confirmed goods would exceed `credit_limit`, the transaction is blocked with `409 credit_limit_exceeded` and an owner alert is sent.
- The backend remembers blocked goods requests. The owner can approve the latest pending request by replying `RAM OVERRIDE Client Name`, or via the credit-limit alert API.
- Pending-review transactions are stored but do not affect balance until confirmed.

## Main Endpoints

- `GET /api/health`
- `GET /api/status`
- `GET /api/qr`
- `GET /sse`
- `GET /api/clients`
- `POST /api/clients`
- `GET /api/transactions?type=goods|payment&client_id=...&status=...&limit=...`
- `POST /api/transactions`
- `PUT /api/transactions/:id/confirm`
- `DELETE /api/transactions/:id`
- `GET /api/goods`
- `POST /api/goods`
- `GET /api/credit-limit-alerts?status=pending`
- `POST /api/credit-limit-alerts/:id/approve`
- `GET /api/payments`
- `POST /api/payments`
- `PUT /api/payments/:id/confirm`
- `DELETE /api/payments/:id`
- `POST /api/test/text`
- `POST /api/test/goods`
- `POST /api/test/payment`
- `POST /api/test-sse`
- `POST /api/test/audio` with multipart field `audio`
- `POST /api/test/image` with multipart field `image`
- `POST /api/send-reminder`

Manual goods body:

```json
{
  "client_id": "client-uuid",
  "amount": 25000,
  "description": "rice bags and oil cartons",
  "status": "confirmed"
}
```

Manual payment body:

```json
{
  "client_id": "client-uuid",
  "amount": 15000,
  "mode": "upi",
  "utr_number": "UPI123456",
  "status": "confirmed"
}
```

Credit limit override command:

```text
RAM OVERRIDE Sharma General Store
```

## SSE Events

The backend sends unnamed SSE messages with `{ "type": "...", "data": ... }`.

- `snapshot`
- `payment`
- `transaction`
- `credit_limit_alert`
- `rating_alert`
- `reminder`
- `whatsapp_status`
- `connection`

## Demo Mode

```text
START_WHATSAPP=false
DEMO_MODE=true
```

Demo mode skips Baileys and broadcasts a fake payment every 30 seconds.

## Production Notes

- The current store is in-memory for hackathon speed. Replace `store/memory.js` with a durable database before production.
- Baileys is not the official WhatsApp Business API. For commercial production, use the official WhatsApp Business Platform or a compliant provider.
- Run long demos under a process manager such as PM2: `pm2 start index.js --name wholesaleledger-backend`.
