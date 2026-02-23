# Paid JSON Tools (open-core)

Live demo (paid unlock): **http://76.13.62.62/**

Tiny server-side JSON utilities with a simple on-chain unlock (pay in USDT on EVM L2s, paste tx hash, receive a 30‑day token).

## What’s here
- The server (Express) that verifies ERC‑20 transfers and issues JWT unlock tokens
- Paid API endpoints:
  - `POST /api/json-to-csv`
  - `POST /api/json-pretty`
- A simple landing page UI (`public/`)

## Why open-core?
Trust + auditability (payment verification logic) + an easy way to self-host.

## Self-host

```bash
npm i
cp .env.example .env
# set PAY_TO + JWT_SECRET
node --env-file=.env server.js
```

## Configure
- `PAY_TO`: recipient address
- `JWT_SECRET`: 32+ chars
- `APP_PORT`: default 3000
- `PRICE_UNITS`: default 1
- `CHAINS_JSON` (optional): override RPCs + token addresses

## Notes
This project is intentionally simple. If you want more tools added, open an issue.
