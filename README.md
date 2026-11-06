# Aarcade Governance

This is the voting engine behind the AavegotchiDAO proposals page on [aarcadeghst.com](https://aarcadeghst.com/dao/propose). It replaces the Snapshot space `aavegotchi.eth`.

The code is published so any DAO member can read exactly how proposals are created, how votes are signed and weighted, and how results are counted. You can also check the live results yourself.

The code here is the same as what runs in production at AarcadeGh$t commit `8608f8a9a`. The files are copied unchanged. The only addition is `lib/mongodb.cjs`, which is cut down to the two functions the engine uses. The rest of the arcade isn't part of this repo.

## How a vote works

1. **Proposal.** Each proposal records its type, choices, start and end, privacy setting and a Base block number. The block number is the snapshot. A proposal's id is the keccak256 hash of its fields, written as JSON with sorted keys (`lib/governance/votes.cjs`).
2. **Signing.** Your wallet signs an EIP-712 `Vote` message containing `from, space, proposal, choice, reason, app, timestamp`, with the domain `Aarcade Governance` v1. The domain has no chain id, matching Snapshot.
   - Ordinary wallets are checked with `verifyTypedData`.
   - Smart wallets and Safes are checked with EIP-1271 on Base.
   - Nobody can vote on your behalf.
3. **Voting power.** Voting power is read at the proposal's snapshot block. The strategies are in `lib/governance/space.config.cjs`:
   - GHST;
   - wearables, at fixed prices from `wearablePrices.json`;
   - REALM;
   - staked LP.

   They copy the old Snapshot space's strategies, so you get the same voting power you had on Snapshot. The code is in `lib/governance/votingPower.cjs`.
4. **Counting.** The tally is in `lib/governance/votes.cjs`:
   - **Weighted:** your voting power is split across choices in the proportions you choose.
   - **Ranked choice:** instant runoff. The last-place choice is eliminated each round until one choice has a majority.
   - **Poll:** one wallet, one vote. Holdings don't matter beyond the minimum voting power to vote.
   - **Quorum:** 7.2M voting power for SigProps and Core AGIPs. Polls have no quorum.
5. **Blind votes.** Choices are encrypted in the browser with drand timelock encryption, locked to the drand round that fires when voting closes. Until then nobody can read them, including whoever runs this server, because no one holds a decryption key. After the round fires, anyone can decrypt them (`lib/governance/shield.cjs`).
6. **Public audit copies.** Every proposal, frozen voting-power table and signed vote is uploaded unchangeably to Grove (Lens storage). Anyone can fetch them and recount (`lib/governance/grove.cjs`).
7. **Who can propose.** Wallets on the Proposers whitelist, plus the owner. Hackathon council wallets are added to the whitelist automatically. The code is in `lib/governance/permissions.cjs` and `auth.cjs`.

## Check the results yourself

The production API is public and read-only:

```sh
# all proposals
curl 'https://aarcadeghst.com/api/governance?action=proposals'
# one proposal, with its live results and every signed vote
curl 'https://aarcadeghst.com/api/governance?action=proposal&id=0x…'
```

To recount a proposal:
1. Check each vote's signature against `VOTE_TYPES` and the domain above.
2. Re-read each voter's voting power at `snapshot`.
3. Run `tally()` from `lib/governance/votes.cjs`.

The old Snapshot proposals are archived here too (`action=archive`, `archive-proposal`). A Snapshot-shaped GraphQL API is available for existing tools (`lib/governance/snapshotCompat.cjs`).

## Run the tests

```sh
npm install
npm test      # 46 tests, using an in-memory database; no secrets or network needed
```

## Layout

| Path | What it does |
|---|---|
| `lib/governance/space.config.cjs` | Space settings: strategies, quorum, voting types, categories |
| `lib/governance/votes.cjs` | EIP-712 vote format, signature checks, choice validation, tally |
| `lib/governance/votingPower.cjs` | Voting power at a block, per strategy |
| `lib/governance/shield.cjs` | Blind votes (drand timelock) |
| `lib/governance/service.cjs` | Creating, editing and cancelling proposals, casting votes, results |
| `lib/governance/permissions.cjs`, `auth.cjs` | Who may propose and edit; proposer sign-in |
| `lib/governance/store.cjs` | MongoDB storage |
| `lib/governance/grove.cjs` | Public audit copies on Grove |
| `lib/governance/snapshotArchive.cjs`, `snapshotCompat.cjs` | Old Snapshot proposals; Snapshot-compatible GraphQL |
| `lib/governance/names.cjs`, `links.cjs` | Voter Basename/ENS names; discussion links |
| `api/governance.js` | HTTP API (Vercel function) |
| `test/governance/` | Tests |

## License

Source-available, not open source. See [LICENSE](LICENSE). You may read, run and test this code to audit how AavegotchiDAO votes are run and counted. Other uses need written permission.
