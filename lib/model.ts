// Token Radar's model: one sealed snapshot of the protocol universe in, one ranked board out.
//
// The board ranks protocols that record no token yet by what a token would be worth if the
// protocol's record stayed as it is. The worth is not a flat guess at TVL: it is priced off the
// snapshot's own tokenised protocols, the ones whose tokens already trade, so every figure the
// model uses is a figure the snapshot itself carries.
//
//   peers        the tokenised protocols (a market cap and a TVL on record): each prices at
//                ratio = mcap_usd / tvl_usd, winsorised to [0.02, 4] so one 400x outlier
//                cannot bend the market it is meant to describe
//   peerMultiple a category's median peer ratio, shrunk toward the market median by its peer
//                count: (n x category median + 6 x market median) / (n + 6); a category with
//                no tokenised peers prices at the market median itself
//   chainFactor  the same shrinkage (k = 12) over the peers whose first chain matches the
//                protocol's first chain, expressed against the market median and clamped to
//                [0.75, 1.33]: where a chain's tokens price rich or cheap, its pre-token
//                protocols inherit a share of that, never all of it
//   growthMult   1 + clamp(change_7d, -50, 100) / 100 x 0.6, an unreported change counting 0
//   maturityMult 0.80 + 0.40 x min(age_days, 1460) / 1460: a protocol that has run longer with
//                no token has the longer proven record, and a token issued on that record
//                prices off a durable franchise; an unreported age counts 365 days
//   implied      max(1, round(tvl_usd x peerMultiple x chainFactor x growthMult x maturityMult))
//
// Every multiplier is rounded to 4 decimals before the implied value is taken, so the number
// board.json carries is exactly the number the dashboard recomputes from the same components.
// No protocol name is ever special-cased: one function scores every row.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's version label: the dashboard names it and the board's rows carry it. */
export const MODEL_VERSION = 'peer-priced-2';

/** The board carries every rankable pre-token protocol at or above this TVL, bounded below and above. */
export const BOARD_TVL_FLOOR = 10_000_000;
export const BOARD_MIN_ROWS = 150;
export const BOARD_MAX_ROWS = 260;

/** How many live-token protocols the dashboard's Live view carries, by market cap. */
export const LIVE_ROWS = 24;

/** The calibration constants, stated on the dashboard so a reader can re-derive any row. */
export const CALIBRATION = {
  ratio_floor: 0.02,
  ratio_cap: 4,
  category_shrinkage: 6,
  chain_shrinkage: 12,
  chain_factor_floor: 0.75,
  chain_factor_cap: 1.33,
  growth_floor_pct: -50,
  growth_cap_pct: 100,
  growth_weight: 0.6,
  maturity_floor: 0.8,
  maturity_range: 0.4,
  maturity_days: 1460,
  unknown_age_days: 365,
} as const;

/** One protocol's implied-value breakdown: every component the dashboard shows and recomputes. */
export interface ValueBreakdown {
  peer_multiple: number;
  category_peers: number;
  chain_factor: number;
  chain_peers: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  age_days: number | null;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: ValueBreakdown;
  farm_steps: string[];
}

/** The dashboard's view of one board row: the row itself, farm plan included. */
export interface RadarRow extends BoardRow {}

/** A live-token protocol: it already trades, so the page shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  mcap_tvl: number | null;
}

/** One category's calibrated multiple, as the dashboard's model panel states it. */
export interface CategoryMultiple {
  category: string;
  multiple: number;
  peers: number;
}

/** Everything the dashboard needs: the board, the live set, and the calibration behind the board. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  calibration: {
    market_median: number;
    peer_count: number;
    ratio_floor: number;
    ratio_cap: number;
    category_shrinkage: number;
    chain_shrinkage: number;
    growth_floor_pct: number;
    growth_cap_pct: number;
    growth_weight: number;
    maturity_floor: number;
    maturity_range: number;
    maturity_days: number;
    unknown_age_days: number;
    categories: CategoryMultiple[];
  };
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all: no market cap, no CoinGecko id, no symbol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a pre-token protocol is one the board may rank: not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The first chain a protocol names, or null when it names none. */
function primaryChain(p: SnapshotProtocol): string | null {
  return p.chains.length > 0 ? p.chains[0]! : null;
}

// ------------------------------------------------------------------ calibration

/** A tokenised protocol that can price a peer: it carries both a market cap and a TVL. */
interface Peer {
  category: string | null;
  chain: string | null;
  ratio: number;
}

/** The snapshot's pricing peers: tokenised protocols, each at its winsorised mcap/TVL ratio. */
function pricingPeers(snapshot: Snapshot): Peer[] {
  const peers: Peer[] = [];
  for (const p of snapshot.protocols) {
    if (isPreToken(p) || p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    peers.push({ category: p.category, chain: primaryChain(p), ratio: clamp(p.mcap_usd / p.tvl_usd, CALIBRATION.ratio_floor, CALIBRATION.ratio_cap) });
  }
  return peers;
}

/** The median of a non-empty list of numbers. */
function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A group's median ratio shrunk toward the market median: (n x group + k x market) / (n + k). */
function shrunkMedian(ratios: number[], marketMedian: number, k: number): number {
  if (ratios.length === 0) return marketMedian;
  return (ratios.length * medianOf(ratios) + k * marketMedian) / (ratios.length + k);
}

/** The calibrated multiples the whole board prices off: one market median, per-category and per-chain. */
export interface CalibrationTable {
  market_median: number;
  peer_count: number;
  byCategory: Map<string | null, { multiple: number; peers: number }>;
  byChain: Map<string, { factor: number; peers: number }>;
}

/** Calibrate the peer multiples from the snapshot's own tokenised protocols. */
export function calibrate(snapshot: Snapshot): CalibrationTable {
  const peers = pricingPeers(snapshot);
  const marketMedian = peers.length > 0 ? medianOf(peers.map((p) => p.ratio)) : 0.25;
  const byCategory = new Map<string | null, { multiple: number; peers: number }>();
  const byChain = new Map<string, { factor: number; peers: number }>();
  const catRatios = new Map<string | null, number[]>();
  const chainRatios = new Map<string, number[]>();
  for (const peer of peers) {
    const cat = catRatios.get(peer.category) ?? [];
    cat.push(peer.ratio);
    catRatios.set(peer.category, cat);
    if (peer.chain !== null) {
      const ch = chainRatios.get(peer.chain) ?? [];
      ch.push(peer.ratio);
      chainRatios.set(peer.chain, ch);
    }
  }
  for (const [category, ratios] of catRatios) {
    byCategory.set(category, { multiple: round4(shrunkMedian(ratios, marketMedian, CALIBRATION.category_shrinkage)), peers: ratios.length });
  }
  for (const [chain, ratios] of chainRatios) {
    const relative = shrunkMedian(ratios, marketMedian, CALIBRATION.chain_shrinkage) / marketMedian;
    byChain.set(chain, { factor: round4(clamp(relative, CALIBRATION.chain_factor_floor, CALIBRATION.chain_factor_cap)), peers: ratios.length });
  }
  return { market_median: round4(marketMedian), peer_count: peers.length, byCategory, byChain };
}

/** The growth multiplier: seven-day TVL momentum, clamped so one hot week cannot carry a board. */
export function growthMultiplier(change7d: number | null): number {
  const g = clamp(change7d ?? 0, CALIBRATION.growth_floor_pct, CALIBRATION.growth_cap_pct);
  return round4(1 + (g / 100) * CALIBRATION.growth_weight);
}

/** The maturity multiplier: the longer a protocol has run with no token, the fuller its record. */
export function maturityMultiplier(age: number | null): number {
  const days = age ?? CALIBRATION.unknown_age_days;
  return round4(CALIBRATION.maturity_floor + (Math.min(Math.max(days, 0), CALIBRATION.maturity_days) / CALIBRATION.maturity_days) * CALIBRATION.maturity_range);
}

/** One protocol's implied value and the breakdown the dashboard shows for it. */
export function impliedValue(p: SnapshotProtocol, asOf: string, table: CalibrationTable): { implied: number; breakdown: ValueBreakdown } {
  const age = ageDays(asOf, p.listed_at);
  const cat = table.byCategory.get(p.category) ?? { multiple: table.market_median, peers: 0 };
  const chainName = primaryChain(p);
  const chain = chainName !== null ? table.byChain.get(chainName) : undefined;
  const breakdown: ValueBreakdown = {
    peer_multiple: cat.multiple,
    category_peers: cat.peers,
    chain_factor: chain?.factor ?? 1,
    chain_peers: chain?.peers ?? 0,
    growth_multiplier: growthMultiplier(p.change_7d),
    maturity_multiplier: maturityMultiplier(age),
    age_days: age,
  };
  const implied = Math.max(
    1,
    Math.round(p.tvl_usd * breakdown.peer_multiple * breakdown.chain_factor * breakdown.growth_multiplier * breakdown.maturity_multiplier),
  );
  return { implied, breakdown };
}

// ------------------------------------------------------------------ farm plans

/** A farm step before it is flattened: the action, what it costs, how long it takes. */
interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** Whole dollars with thousands separators, for step text. */
function usd(n: number): string {
  return `$${n.toLocaleString('en-US')}`;
}

/** The gas asset a chain settles fees in, for the chains farmers actually bridge to. */
const GAS_ASSET: Record<string, string> = {
  Ethereum: 'ETH', Base: 'ETH', Arbitrum: 'ETH', Optimism: 'ETH', 'zkSync Era': 'ETH', Linea: 'ETH',
  Scroll: 'ETH', Unichain: 'ETH', 'World Chain': 'ETH', Abstract: 'ETH', Binance: 'BNB', 'BNB Chain': 'BNB',
  Solana: 'SOL', Avalanche: 'AVAX', Polygon: 'POL', Fantom: 'FTM', Tron: 'TRX', Sui: 'SUI', Aptos: 'APT',
  Near: 'NEAR', Bitcoin: 'BTC', TON: 'TON', 'Hyperliquid L1': 'HYPE', Cronos: 'CRO', Gnosis: 'xDAI',
  Celo: 'CELO', Mantle: 'MNT', Sei: 'SEI', Sonic: 'S', Berachain: 'BERA', Cosmos: 'ATOM', Injective: 'INJ',
  Osmosis: 'OSMO', Hedera: 'HBAR', Cardano: 'ADA', Stellar: 'XLM', Kaspa: 'KAS', Moonbeam: 'GLMR',
};

/** One round trip's gas on a chain, in words: L2s are cents-to-dollars, Ethereum is not. */
function gasNote(chain: string | null): string {
  if (chain === 'Ethereum') return 'about $10 in gas at ordinary fees';
  if (chain === 'Solana') return 'well under $1 in fees';
  if (chain === 'Bitcoin') return 'about $2 in miner fees';
  if (chain === 'Tron') return 'about $1 in energy and bandwidth';
  return 'about $1-3 in gas';
}

/** How much capital one farm position needs, scaled to the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 500;
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 250_000_000) return 150;
  if (p.tvl_usd >= 50_000_000) return 100;
  if (p.tvl_usd >= 10_000_000) return 50;
  return 25;
}

/** How long to hold, from the protocol's age: younger protocols run longer qualifying windows. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 75;
  if (age < 365) return 60;
  if (age < 730) return 45;
  return 30;
}

/** A category's playbook: the opening position, the second leg, and the activity that counts. */
interface Playbook {
  open: (p: SnapshotProtocol, capital: number, chain: string) => string;
  deepen: (p: SnapshotProtocol, capital: number, chain: string) => string;
  activity: (p: SnapshotProtocol, capital: number, chain: string) => string;
  weekly: string;
}

function playbookFor(category: string | null): Playbook {
  const c = (category ?? '').toLowerCase();
  if (c.includes('dex') || c.includes('liquidity manager')) {
    return {
      open: (p, capital, chain) => `Swap ${usd(capital)} of USDC into the main pair on ${p.name} (${chain}) and add it as liquidity to that pool, so the wallet both trades and provides on the venue.`,
      deepen: (p, capital, chain) => `Add a second, smaller position of ${usd(Math.round(capital / 2))} to another active pool on ${p.name} and leave both ranges untouched for a week before rebalancing.`,
      activity: (p, capital) => `Route at least ${usd(capital * 20)} of swap volume through ${p.name} across the season, spread over several days rather than one burst, so the flow reads as use, not wash.`,
      weekly: 'one swap plus a liquidity check',
    };
  }
  if (c.includes('lend') || c.includes('uncollateralized') || c.includes('collateral markets')) {
    return {
      open: (p, capital, chain) => `Supply ${usd(capital)} of USDC to ${p.name} on ${chain} as collateral and keep the supply position open; supplying is the act most lending points programs count first.`,
      deepen: (p, capital) => `Borrow about ${usd(Math.round(capital * 0.4))} against the supply for a few days, then repay in full: one clean borrow-and-repay cycle shows the wallet used both sides of ${p.name}.`,
      activity: (p, capital) => `Keep total supplied value on ${p.name} at or above ${usd(capital)} for the whole window; snapshots of supplied balances are what lending farms usually reward, not single deposits.`,
      weekly: 'one supply top-up or rate check',
    };
  }
  if (c.includes('derivative') || c.includes('option') || c.includes('perpetual')) {
    return {
      open: (p, capital, chain) => `Deposit ${usd(capital)} of USDC as margin on ${p.name} (${chain}) and open one small position hedged against a spot holding elsewhere, so the account trades without directional risk.`,
      deepen: (p, capital) => `Trade a second instrument on ${p.name} (a different pair or expiry) for at least one session, so the account is not a single-market wallet.`,
      activity: (p, capital) => `Build at least ${usd(capital * 40)} of cumulative traded volume on ${p.name} in small, hedged clips over several weeks; perps programs weight volume and open-interest days, not one large trade.`,
      weekly: 'one hedged trade, about 20 minutes',
    };
  }
  if (c.includes('staking') || c.includes('restak')) {
    return {
      open: (p, capital, chain) => `Stake ${usd(capital)} worth of the chain's staking asset through ${p.name} on ${chain} and keep the liquid receipt token in the same wallet that staked.`,
      deepen: (p, capital) => `Put about half the receipt tokens to work in one integrated venue ${p.name} lists (a lending market or pool), and keep the other half idle as proof of the original stake.`,
      activity: (p, capital) => `Hold the staked position through at least two reward epochs on ${p.name}; staking farms count duration and average balance, so an early unstake forfeits most of the window.`,
      weekly: 'one rewards and unbonding-period check',
    };
  }
  if (c.includes('bridge')) {
    return {
      open: (p, capital, chain) => `Bridge ${usd(capital)} of USDC through ${p.name} to ${chain} and, once it lands, use the funds in one app on the destination chain instead of bridging straight back.`,
      deepen: (p, capital) => `Bridge a second asset or a second route through ${p.name} on a different day; route diversity is what bridge points tables usually record.`,
      activity: (p, capital) => `Reach at least ${usd(capital * 10)} of cumulative bridged volume through ${p.name}, in crossings of ${usd(Math.max(25, Math.round(capital / 2)))} or more, spaced across the window.`,
      weekly: 'one crossing every week or two',
    };
  }
  if (c.includes('cdp') || c.includes('stable')) {
    return {
      open: (p, capital, chain) => `Open a collateral position on ${p.name} (${chain}) with ${usd(capital)} of collateral and mint about ${usd(Math.round(capital * 0.5))} of its stablecoin against it, keeping the health factor comfortably above liquidation.`,
      deepen: (p, capital) => `Hold or deploy the minted stablecoin in one venue ${p.name} integrates with, rather than selling it at once, so both the vault and the coin carry the wallet's activity.`,
      activity: (p, capital) => `Keep the vault open and above ${usd(Math.round(capital * 0.5))} of debt for the full window; stablecoin farms count vault-days and average debt, not the mint alone.`,
      weekly: 'one collateral health check',
    };
  }
  if (c.includes('yield') || c.includes('curator') || c.includes('allocator') || c.includes('basis') || c.includes('farm') || c.includes('index')) {
    return {
      open: (p, capital, chain) => `Deposit ${usd(capital)} of USDC into the main vault or strategy on ${p.name} (${chain}) and keep the vault shares in the depositing wallet.`,
      deepen: (p, capital) => `Split a second deposit of ${usd(Math.round(capital / 2))} into a different ${p.name} vault or strategy, so the wallet is not riding on a single strategy's snapshot.`,
      activity: (p, capital) => `Keep the combined vault balance on ${p.name} at or above ${usd(capital)} for the whole window; yield farms snapshot balances, so a mid-window withdrawal cuts the average that counts.`,
      weekly: 'one balance and vault-health check',
    };
  }
  if (c.includes('rwa')) {
    return {
      open: (p, capital, chain) => `Subscribe ${usd(capital)} to the main tokenised asset on ${p.name} (${chain}), completing whatever allowlist or terms step its app asks of holders first.`,
      deepen: (p, capital) => `Hold the asset through at least one full yield distribution on ${p.name} instead of redeeming at the first window; holder duration is the record these issuers keep.`,
      activity: (p, capital) => `Keep at least ${usd(capital)} subscribed on ${p.name} for the full window and claim each distribution from the app as it lands.`,
      weekly: 'one distribution and redemption-window check',
    };
  }
  if (c.includes('prediction')) {
    return {
      open: (p, capital, chain) => `Fund ${usd(capital)} on ${p.name} (${chain}) and take positions in at least three unrelated markets, sized small, so the account reads as a participant rather than a single bet.`,
      deepen: (p, capital) => `Provide liquidity to one market on ${p.name} by holding both sides of a near-even book for a day, then settle or exit cleanly.`,
      activity: (p, capital) => `Reach at least ${usd(capital * 15)} of cumulative traded volume on ${p.name} across the window, a few markets a week, and let positions settle rather than always selling early.`,
      weekly: 'two or three market positions',
    };
  }
  if (c.includes('insurance')) {
    return {
      open: (p, capital, chain) => `Stake ${usd(capital)} into the underwriting or staking pool on ${p.name} (${chain}); cover protocols count the capital that backs policies, not policy purchases alone.`,
      deepen: (p, capital) => `Buy one small cover policy through ${p.name} as well, so the wallet appears on both sides of the protocol.`,
      activity: (p, capital) => `Keep the stake locked on ${p.name} for the full window: underwriting stakes usually carry a cooldown, and leaving early restarts it.`,
      weekly: 'one pool and claims check',
    };
  }
  if (c.includes('launchpad')) {
    return {
      open: (p, capital, chain) => `Stake or hold ${usd(capital)} in the tier asset ${p.name} asks for on ${chain}, at the lowest tier that still qualifies for allocations.`,
      deepen: (p, capital) => `Take part in one sale on ${p.name} at a small size and hold the received tokens past listing day rather than flipping them at open.`,
      activity: (p, capital) => `Keep the qualifying stake on ${p.name} unbroken for the full window; launchpad tiers are usually snapshotted at each sale, and a gap drops the tier.`,
      weekly: 'one sale-calendar check',
    };
  }
  if (c.includes('chain')) {
    return {
      open: (p, capital, chain) => `Bridge ${usd(capital)} to ${p.name}'s chain and make the wallet a resident: fund it, then use two or three of the chain's native apps in the first week.`,
      deepen: (p, capital) => `Hold a balance of the chain's gas asset and one ecosystem token in the wallet, and transact on at least ten separate days.`,
      activity: (p, capital) => `Keep at least ${usd(Math.round(capital / 2))} of value on the chain for the full window; ecosystem programs count resident balances and active days, not bridge volume alone.`,
      weekly: 'two or three small transactions',
    };
  }
  if (c.includes('privacy')) {
    return {
      open: (p, capital, chain) => `Deposit ${usd(capital)} into ${p.name} on ${chain} through its own interface and keep the note or commitment the app issues; privacy pools count deposits that stay shielded.`,
      deepen: (p, capital) => `Make one shielded transfer or withdrawal to a second wallet you control after a delay of several days, following the app's own guidance on denominations.`,
      activity: (p, capital) => `Keep funds shielded on ${p.name} for the full window; time-in-pool is the signal privacy protocols can measure without deanonymising anyone.`,
      weekly: 'one pool and anonymity-set check',
    };
  }
  if (c.includes('payment') || c.includes('card')) {
    return {
      open: (p, capital, chain) => `Fund ${usd(capital)} on ${p.name} (${chain}) and make the wallet's first real payment or card transaction, however small, so the account is active rather than parked.`,
      deepen: (p, capital) => `Route one recurring payment (a subscription or a transfer you already make) through ${p.name} for the window.`,
      activity: (p, capital) => `Keep a working balance of at least ${usd(Math.round(capital / 2))} on ${p.name} and transact in at least six separate weeks; payment products count active months.`,
      weekly: 'one real transaction',
    };
  }
  if (c.includes('nft')) {
    return {
      open: (p, capital, chain) => `List or buy one item on ${p.name} (${chain}) with about ${usd(Math.round(capital / 2))} of value, using the marketplace's own flow end to end.`,
      deepen: (p, capital) => `Make offers on two or three collections on ${p.name} rather than a single purchase, so the account shows ordinary marketplace behaviour.`,
      activity: (p, capital) => `Reach at least ${usd(capital * 5)} of cumulative volume on ${p.name} across the window in ordinary trades, and hold one purchase for at least a month.`,
      weekly: 'one listing, offer or trade',
    };
  }
  return {
    open: (p, capital, chain) => `Deposit ${usd(capital)} of USDC into ${p.name} on ${chain} through its main app flow and keep the position open; a live position is the baseline every points program counts.`,
    deepen: (p, capital) => `Use a second feature of ${p.name} (a second market, vault or mode) with about ${usd(Math.round(capital / 2))}, so the wallet is not a single-action account.`,
    activity: (p, capital) => `Keep at least ${usd(capital)} of value working on ${p.name} for the whole window; balance snapshots across time are the common denominator of pre-token programs.`,
    weekly: 'one qualifying action',
  };
}

/**
 * A protocol's farm plan: seven steps in order, each an action with a cost and a time, derived
 * from the protocol's own record (category playbook, chains, TVL-sized capital, age-sized hold,
 * and a growth note when its seven-day move is large enough to change how a farmer should enter).
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = primaryChain(p) ?? 'its main chain';
  const gas = GAS_ASSET[chain] ?? 'the native gas token';
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const book = playbookFor(p.category);
  const steps: FarmStep[] = [
    {
      text: `Start from a fresh wallet that holds only the funds you plan to farm with, and fund it on ${chain} with ${gas} for fees before you touch ${p.name}; keep its seed phrase offline and never reuse an exchange deposit address as the farm wallet.`,
      cost: `${gasNote(chain)} to fund and make the first transaction`,
      time: '10 minutes',
    },
    {
      text: book.open(p, capital, chain),
      cost: `${usd(capital)} of capital, ${gasNote(chain)}`,
      time: '15 minutes to set up',
    },
    {
      text: book.deepen(p, capital, chain),
      cost: `${usd(Math.round(capital / 2))} more of capital at most, ${gasNote(chain)}`,
      time: '15 minutes, in the second week',
    },
  ];
  if (p.chains.length > 1) {
    steps.push({
      text: `Repeat a small version of the position on ${p.chains[1]}, the second chain ${p.name} counts TVL on: bridge about ${usd(Math.round(capital / 4))} across and open the same kind of position there, since multi-chain activity is visible in the protocol's own records.`,
      cost: `${usd(Math.round(capital / 4))} of capital plus bridge fees of a few dollars`,
      time: '20 minutes, once',
    });
  }
  steps.push({
    text: book.activity(p, capital, chain),
    cost: 'gas on each action, budgeted in the weekly step below',
    time: 'spread across the season',
  });
  const growth = p.change_7d;
  const growthNote =
    growth !== null && growth >= 25
      ? ` ${p.name}'s TVL is up ${growth.toFixed(1)}% in seven days: enter in two tranches a week apart instead of one deposit, so a crowded week does not set your whole entry.`
      : growth !== null && growth <= -20
        ? ` ${p.name}'s TVL is down ${Math.abs(growth).toFixed(1)}% in seven days: keep this at the starter size until the outflow flattens for a full week.`
        : '';
  steps.push({
    text: `Keep a weekly cadence of ${book.weekly} on ${p.name}, in the same wallet every time.${growthNote}`,
    cost: 'about $2 a week in gas on most chains, nearer $10 on Ethereum',
    time: '10 minutes a week',
  });
  steps.push({
    text: `Hold the position for at least ${hold} days so it stands in several weekly snapshots, and check ${p.name}'s own points or rewards page weekly for the balance it credits to this wallet.`,
    cost: `the ${usd(capital)} stays in the position; checking is free`,
    time: `${hold} days of holding, 5 minutes a week to check`,
  });
  steps.push({
    text: `When you finish, claim only from links ${p.name} publishes in its own app or announcements, never from a search result or a direct message, and never pay a fee to claim; then unwind the position, repay anything borrowed, and log the wallet, dates and transactions so the farm can be repeated or audited.`,
    cost: 'gas to unwind, and nothing to claim: a claim that asks for a fee is a scam',
    time: '20 minutes to unwind',
  });
  return steps;
}

// ------------------------------------------------------------------ the board

/** The protocols the board ranks: the watchlist whole, plus rankable pre-token protocols by TVL. */
export function selectBoardProtocols(snapshot: Snapshot): SnapshotProtocol[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const candidates = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const p of candidates) {
    if (chosen.size >= BOARD_MAX_ROWS) break;
    if (p.tvl_usd >= BOARD_TVL_FLOOR || chosen.size < BOARD_MIN_ROWS) chosen.set(p.slug, p);
  }
  return [...chosen.values()];
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const table = calibrate(snapshot);
  const watch = new Set(snapshot.watchlist);
  const scored = selectBoardProtocols(snapshot).map((p) => {
    const { implied, breakdown } = impliedValue(p, snapshot.as_of, table);
    return { p, implied, breakdown };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    watchlist: watch.has(s.p.slug),
    age_days: s.breakdown.age_days,
    implied_value_usd: s.implied,
    model: s.breakdown,
    farm_steps: farmSteps(s.p, s.breakdown.age_days).map(stepText),
  }));
}

/** The live-token protocols, by market cap: they already trade, so the market's value, not a model's. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      mcap_tvl: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const table = calibrate(snapshot);
  const live = liveRows(snapshot);
  const categories: CategoryMultiple[] = [...table.byCategory.entries()]
    .map(([category, v]) => ({ category: category ?? 'Uncategorised', multiple: v.multiple, peers: v.peers }))
    .sort((a, b) => b.peers - a.peers || (a.category < b.category ? -1 : 1));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    calibration: {
      market_median: table.market_median,
      peer_count: table.peer_count,
      ratio_floor: CALIBRATION.ratio_floor,
      ratio_cap: CALIBRATION.ratio_cap,
      category_shrinkage: CALIBRATION.category_shrinkage,
      chain_shrinkage: CALIBRATION.chain_shrinkage,
      growth_floor_pct: CALIBRATION.growth_floor_pct,
      growth_cap_pct: CALIBRATION.growth_cap_pct,
      growth_weight: CALIBRATION.growth_weight,
      maturity_floor: CALIBRATION.maturity_floor,
      maturity_range: CALIBRATION.maturity_range,
      maturity_days: CALIBRATION.maturity_days,
      unknown_age_days: CALIBRATION.unknown_age_days,
      categories,
    },
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.watchlist).length,
    live_size: live.length,
    rows: board,
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: size, coverage, ranks, order, values, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  const slugs = new Set<string>();
  for (const r of board) {
    if (!known.has(r.slug)) return `${r.slug} is not one of the snapshot's protocols`;
    if (slugs.has(r.slug)) return `${r.slug} appears twice`;
    slugs.add(r.slug);
    if (r.name.trim() === '') return `${r.slug} has an empty name`;
  }
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 0; i < byRank.length; i++) {
    if (byRank[i]!.rank !== i + 1) return `rank ${i + 1} is ${byRank[i]!.rank}`;
    if (i > 0 && byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `rank ${i + 1} outranks rank ${i} on implied value`;
  }
  if (board.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) {
    return 'every row shares one implied value: a board that ranks nothing by value is not a ranking';
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
