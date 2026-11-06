/**
 * Self-hosted governance — single-space config.
 *
 * This is the one file another DAO edits to run its own voting. Strategies mirror the
 * live Snapshot space `aavegotchi.eth` (Base) as of 2026-11-03, so voting power matches
 * what voters saw on Snapshot.
 */
const WEARABLE_PRICES = require('./wearablePrices.json');

module.exports = {
  id: 'aavegotchi-dao',
  name: 'Aavegotchi DAO',
  /** Legacy Snapshot space — read-only archive of pre-migration proposals. */
  legacySnapshotSpace: 'aavegotchi.eth',
  chainId: 8453,
  quorum: 7_200_000,
  /** Votes below this VP are rejected (Snapshot `filters.minScore`). */
  minVoteVp: 1,
  /** Proposal voting types this space allows (per proposal). */
  votingTypes: ['weighted', 'ranked-choice', 'poll'],
  /**
   * 'poll' = one wallet, one vote (pick one choice; holdings don't matter beyond minVoteVp).
   * Used only by the Poll category. Its quorum is a voter count (0 = none).
   */
  pollQuorum: 0,
  /**
   * Per-proposal privacy. 'shielded' = blind voting: choices are drand-timelock encrypted
   * until voting closes so early votes can't sway later voters (lib/governance/shield.cjs).
   */
  privacyModes: ['none', 'shielded'],
  /** EIP-712 domain for signed votes. No chainId, like Snapshot, so wallets on any chain can sign. */
  eip712Domain: { name: 'Aarcade Governance', version: '1' },
  /** Who may create proposals: users passing canAccessAdminDao (see adminCouncilAccess.js). */
  proposerUserTypes: ['founder', 'admin', 'dao_council', 'hackathon_council'],
  /**
   * Staff roles whose wallets are added to the Proposers whitelist automatically (once — if the
   * owner removes one, it stays removed). Everyone else on staff is whitelisted by hand.
   */
  autoWhitelistUserTypes: ['hackathon_council'],
  /**
   * The Aarcade owner wallet: may edit or cancel any proposal. Members added on the admin
   * DAO "Proposers" tab may create proposals and edit/cancel only their own.
   */
  ownerAddress: String(
    process.env.GOVERNANCE_OWNER_ADDRESS || process.env.FOUNDER_WALLET_ADDRESS || '0x2127aa7265d573aa467f1d73554d17890b872e76',
  ).toLowerCase(),
  /** Proposal kinds created on /dao/propose. Election ballots carry an electionId instead. */
  categories: [
    { id: 'sigprop', label: 'SigProp' },
    { id: 'agip', label: 'Core AGIP' },
    // One wallet, one vote (voting type 'poll'); non-binding temperature check.
    { id: 'poll', label: 'Poll' },
  ],

  /**
   * Subgraph for the subgraph-based strategies (wearables, REALM): the AarcadeGh$t
   * `aavegotchi-core-base` subgraph via lib/subgraphUpstream.cjs (needs
   * SUBGRAPH_PROXY_SECRET server-side). Goldsky is being sunset — do not point here.
   */
  subgraphName: 'aavegotchi-core-base',
  /**
   * true only if the subgraph answers `block: { number }` queries. The home Envio compat
   * proxy is not assumed to, so subgraph strategies read the indexer head and proposals
   * freeze that VP at creation (the proposal's snapshot block = indexer head block).
   */
  subgraphTimeTravel: process.env.GOVERNANCE_SUBGRAPH_TIME_TRAVEL === '1',

  strategies: [
    {
      name: 'erc20-balance-of',
      label: 'GHST',
      params: { address: '0xcd2f22236dd9dfe2356d7c543161d4d260fd9bcb', decimals: 18 },
    },
    {
      name: 'aavegotchi-agip',
      label: 'Wearables',
      params: {
        tokenAddress: '0xA99c4B08201F2913Db8D28e71d020c4298F29dBF',
        prices: WEARABLE_PRICES,
        // Gotchis count for their ORIGINAL owner (lent-out gotchis stay with the lender),
        // decided on-chain. These subgraph fields only suggest extra gotchi ids to verify
        // (catches lent-out gotchis no longer in the lender's wallet). [] = on-chain only.
        gotchiCandidateFields: ['originalOwner', 'owner'],
      },
    },
    {
      name: 'aavegotchi-agip-17',
      label: 'REALM',
      // Read from the subgraph: frozen for every holder when a proposal is created.
      source: 'subgraph',
      // AGIP 17: VP by parcel size (humble, reasonable, spacious ×2, partner).
      params: {
        sizeVp: { 0: 32, 1: 128, 2: 1028, 3: 1028, 4: 2048 },
        parcelOwnerField: 'owner',
      },
    },
    {
      name: 'aavegotchi-agip-37-gltr-staked-lp',
      label: 'Staked LP',
      params: {
        ghstAddress: '0xcD2F22236DD9Dfe2356D7C543161D4d260FD9BcB',
        gltrStakingAddress: '0xaB449DcA14413a6ae0bcea9Ea210B57aCe280d2c',
        // [lpTokenAddress, poolId] — order matches score-api's Base version.
        pools: [
          ['0xeae2fB93e291C2eB69195851813DE24f97f1ce71', 0], // GHST-FUD
          ['0x62ab7d558A011237F8a57ac0F97601A764e85b88', 1], // GHST-FOMO
          ['0x0Ba2A49aedf9A409DBB0272db7CDF98aEb1E1837', 2], // GHST-ALPHA
          ['0x699B4eb36b95cDF62c74f6322AaA140E7958Dc9f', 3], // GHST-KEK
          ['0xa83b31D701633b8EdCfba55B93dDBC202D8A4621', 5], // GHST-GLTR
          ['0x0DFb9Cb66A18468850d6216fCc691aa20ad1e091', 4], // GHST-WETH
        ],
      },
    },
  ],
};
