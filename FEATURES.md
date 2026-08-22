# Feature Requests — synccenter

## Open

### FR-001 · Handle sparse files on macOS sources
P2 · added 2026-08-21 · source: Eric
macOS ships openrsync, which has no sparse-file support, so a sync reads and transmits every hole as real zero bytes and writes them out solid at the destination. Detect sparse sources and either use a sparse-aware transfer or warn and skip, instead of silently turning a small file into a huge one. Seen on a Mac mini backup: Docker Desktop's `Docker.raw` was 465.6GB apparent against 8.6GB actually on disk, and the transfer would have moved 465GB of zeros.

## In Progress

## Shipped

## Declined
