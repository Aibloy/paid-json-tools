# On-chain Unlock Starter Kit

You’re buying a tiny, auditable starter that lets you:
- verify an ERC-20 payment to your wallet (USDT on popular EVM L2s)
- mint a JWT unlock token
- gate paid API routes / downloads behind `Authorization: Bearer …`

## What you get
- Express server
- `/config` and `/verify`
- `authRequired` middleware
- Example paid endpoints
- Revenue watcher log (optional)

## How to use
1) Copy the code into your project
2) Set `.env`:
   - `PAY_TO=0xYourWallet`
   - `JWT_SECRET=...` (32+ chars)
   - `PRICE_UNITS=...`
3) Deploy behind Nginx/Caddy

## Notes
This kit is intentionally minimal (no DB, no Stripe, no accounts).
