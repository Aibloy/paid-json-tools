import express from 'express';
import jwt from 'jsonwebtoken';
import { JsonRpcProvider, Interface } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public', { extensions: ['html'] }));

const PORT = Number(process.env.APP_PORT || process.env.PORT || 3000);

// ---- Payments (multi-chain, USDT defaults) ----
// Operator address (any EVM)
const PAY_TO = (process.env.PAY_TO || '').toLowerCase();
if (!PAY_TO) {
  console.error('Missing PAY_TO env var (recipient wallet address).');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET || '';
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('Missing/weak JWT_SECRET env var. Set a 32+ char secret.');
  process.exit(1);
}

const PRICE_UNITS = process.env.PRICE_UNITS || '1'; // e.g. 1 USDT

// Default chain map: tuned for "any EVM" payments in practice (major cheap L2s)
// You can override by setting CHAINS_JSON env var.
const DEFAULT_CHAINS = {
  polygon: {
    chainName: 'Polygon',
    rpcUrl: 'https://polygon-bor.publicnode.com',
    token: { symbol: 'USDT', decimals: 6, address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F' }
  },
  arbitrum: {
    chainName: 'Arbitrum One',
    rpcUrl: 'https://arbitrum-one.publicnode.com',
    token: { symbol: 'USDT', decimals: 6, address: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9' }
  },
  optimism: {
    chainName: 'Optimism',
    rpcUrl: 'https://optimism.publicnode.com',
    token: { symbol: 'USDT', decimals: 6, address: '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58' }
  },
  base: {
    chainName: 'Base',
    rpcUrl: 'https://base.publicnode.com',
    token: { symbol: 'USDT', decimals: 6, address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2' }
  }
};

let CHAINS = DEFAULT_CHAINS;
if (process.env.CHAINS_JSON) {
  try {
    CHAINS = JSON.parse(process.env.CHAINS_JSON);
  } catch {
    console.error('Bad CHAINS_JSON. Must be valid JSON.');
    process.exit(1);
  }
}

const erc20Iface = new Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)'
]);

const LOG_DIR = process.env.REVENUE_LOG_DIR || '/data/.openclaw/workspace/logs';
const REVENUE_LOG = path.join(LOG_DIR, 'revenue-events.log');
function revenueLog(line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(REVENUE_LOG, line + '\n');
  } catch {
    // ignore
  }
}

function parseUnitsToBigInt(unitsStr, decimals) {
  const [whole, frac = ''] = String(unitsStr).split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const s = `${whole}${fracPadded}`.replace(/^0+(?=\d)/, '');
  return BigInt(s || '0');
}

function getChain(key) {
  const k = String(key || '').toLowerCase();
  const c = CHAINS[k];
  if (!c || !c.rpcUrl || !c.token?.address) return null;
  return {
    key: k,
    chainName: c.chainName || k,
    rpcUrl: c.rpcUrl,
    token: {
      symbol: c.token.symbol || 'USDT',
      decimals: Number(c.token.decimals ?? 6),
      address: String(c.token.address).toLowerCase()
    }
  };
}

function getAllChainKeys() {
  return Object.keys(CHAINS || {});
}

function authRequired(req, res, next) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ ok: false, error: 'missing_token' });
  try {
    req.user = jwt.verify(m[1], JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ ok: false, error: 'bad_token' });
  }
}

// ---- Public endpoints ----
app.get('/config', (req, res) => {
  const chains = Object.entries(CHAINS).map(([key, c]) => ({
    key,
    name: c.chainName || key,
    token: {
      symbol: c.token?.symbol || 'USDT',
      decimals: Number(c.token?.decimals ?? 6),
      address: String(c.token?.address || '').toLowerCase()
    }
  }));

  res.json({
    payTo: PAY_TO,
    priceUnits: PRICE_UNITS,
    chains
  });
});

app.post('/verify', async (req, res) => {
  try {
    const { txHash, chain } = req.body || {};
    const selected = getChain(chain);
    if (!selected) return res.status(400).json({ ok: false, error: 'bad_chain' });

    if (!txHash || typeof txHash !== 'string' || !txHash.startsWith('0x') || txHash.length < 66) {
      return res.status(400).json({ ok: false, error: 'bad_txHash' });
    }

    const provider = new JsonRpcProvider(selected.rpcUrl);
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) return res.status(404).json({ ok: false, error: 'not_found' });
    if (receipt.status !== 1) return res.status(400).json({ ok: false, error: 'failed_tx' });

    const PRICE = parseUnitsToBigInt(PRICE_UNITS, selected.token.decimals);

    let paid = false;
    let amount = 0n;

    for (const log of receipt.logs) {
      if (!log.address || log.address.toLowerCase() !== selected.token.address) continue;
      let parsed;
      try {
        parsed = erc20Iface.parseLog({ topics: log.topics, data: log.data });
      } catch {
        continue;
      }
      if (!parsed || parsed.name !== 'Transfer') continue;
      const to = String(parsed.args.to).toLowerCase();
      const value = BigInt(parsed.args.value.toString());
      if (to === PAY_TO && value >= PRICE) {
        paid = true;
        amount = value;
        break;
      }
    }

    if (!paid) return res.status(402).json({ ok: false, error: 'not_paid' });

    const token = jwt.sign(
      {
        scope: 'pro',
        txHash,
        chain: selected.key,
        token: selected.token.symbol,
        amount: amount.toString()
      },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    return res.json({ ok: true, token });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.get('/me', authRequired, (req, res) => {
  return res.json({ ok: true, payload: req.user });
});

// ---- Paid API endpoints (JWT-gated) ----
function rowsToCSV(rows) {
  const keys = Array.from(
    rows.reduce((s, r) => {
      Object.keys(r || {}).forEach((k) => s.add(k));
      return s;
    }, new Set())
  );

  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  const head = keys.map(esc).join(',');
  const body = rows.map((r) => keys.map((k) => esc((r || {})[k])).join(',')).join('\n');
  return head + '\n' + body + '\n';
}

app.post('/api/json-to-csv', authRequired, (req, res) => {
  try {
    const { rows } = req.body || {};
    if (!Array.isArray(rows)) return res.status(400).json({ ok: false, error: 'rows_must_be_array' });
    const csv = rowsToCSV(rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.status(200).send(csv);
  } catch {
    return res.status(400).json({ ok: false, error: 'bad_input' });
  }
});

app.post('/api/json-pretty', authRequired, (req, res) => {
  try {
    const { value } = req.body || {};
    const pretty = JSON.stringify(value, null, 2) + '\n';
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).send(pretty);
  } catch {
    return res.status(400).json({ ok: false, error: 'bad_input' });
  }
});

// ---- Revenue watcher (logs first incoming $) ----
const TRANSFER_TOPIC = erc20Iface.getEvent('Transfer').topicHash;
const TO_TOPIC = '0x000000000000000000000000' + PAY_TO.slice(2);

async function scanChainOnce(chainKey, state) {
  const c = getChain(chainKey);
  if (!c) return;

  if (!state.provider) state.provider = new JsonRpcProvider(c.rpcUrl);
  const provider = state.provider;

  const PRICE = parseUnitsToBigInt(PRICE_UNITS, c.token.decimals);

  const latest = await provider.getBlockNumber();
  if (state.lastBlock === null) {
    state.lastBlock = Math.max(0, latest - 500); // cold start window
  }

  const fromBlock = state.lastBlock + 1;
  const toBlock = latest;
  if (fromBlock > toBlock) return;

  const logs = await provider.getLogs({
    address: c.token.address,
    fromBlock,
    toBlock,
    topics: [TRANSFER_TOPIC, null, TO_TOPIC]
  });

  for (const log of logs) {
    let parsed;
    try {
      parsed = erc20Iface.parseLog({ topics: log.topics, data: log.data });
    } catch {
      continue;
    }
    const value = BigInt(parsed.args.value.toString());
    if (value < PRICE) continue;

    const line = JSON.stringify({
      at: new Date().toISOString(),
      chain: c.key,
      token: c.token.symbol,
      to: PAY_TO,
      value: value.toString(),
      txHash: log.transactionHash
    });

    console.log('[revenue]', line);
    revenueLog(line);
  }

  state.lastBlock = latest;
}

function startRevenueWatcher() {
  const states = new Map();
  for (const k of getAllChainKeys()) {
    states.set(k, { lastBlock: null, provider: null });
  }

  const tick = async () => {
    for (const [k, st] of states.entries()) {
      try {
        await scanChainOnce(k, st);
      } catch (e) {
        // keep it quiet (cheap VPS); just note minimal
        console.error('[revenue_scan_error]', k, e?.message || e);
      }
    }
  };

  // run now + every 60s
  tick();
  setInterval(tick, 60_000).unref?.();
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`paid-json-tools listening on :${PORT}`);
  startRevenueWatcher();
});
