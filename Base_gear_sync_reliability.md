-- Base Gear Sync Reliability Logic
-- Purpose:
-- Safely refresh a user's Base gear ownership without deleting existing gear
-- when RPC calls are incomplete, delayed, rate-limited, or partially failed.

-- Core rule:
-- Existing synced gear should never disappear because of a failed sync.
-- Ownership refresh must be safe first, destructive only when the scan is complete.

-- Sync flow:
-- 1. Load the authenticated user's active Base wallet.
-- 2. Read the wallet's NFT balance from the Base gear contract.
-- 3. If balance lookup fails:
--    - stop sync
--    - keep existing gear rows
--    - return partial sync response
-- 4. Discover owned token IDs using Transfer event logs.
-- 5. If token discovery is incomplete:
--    - upsert any discovered owned gear
--    - do not prune existing rows
--    - return partial sync response
-- 6. If token discovery is complete and discovered count matches wallet balance:
--    - upsert owned gear rows
--    - preserve currently equipped gear
--    - prune only stale gear rows that are confirmed no longer owned
-- 7. Metadata fetch must be optional.
--    - token ownership should still sync even if metadata is slow or unavailable.

-- Safety conditions before pruning stale gear:
-- - wallet balance lookup succeeded
-- - token discovery completed successfully
-- - discovered owned count matches wallet balance
-- - database upsert succeeded
-- - no critical RPC errors occurred

-- If any condition fails:
-- - do not delete rows
-- - do not clear equipped gear
-- - keep existing gear visible in the app
-- - return a safe partial sync response

-- Equipped gear preservation:
-- If the user's currently equipped gear is still owned, keep it equipped.
-- If no equipped gear exists, equip the lowest owned token ID.
-- Do not auto-switch equipped gear during a normal sync.

-- Expected sync result fields:
-- success
-- partial
-- expected_balance
-- owned_count
-- owned_token_ids
-- scan_complete
-- prune_applied
-- warning_code

-- Example successful result:
-- success = true
-- partial = false
-- expected_balance = 6
-- owned_count = 6
-- owned_token_ids = [1, 2, 3, 4, 5, 6]
-- scan_complete = true
-- prune_applied = true

-- Example partial result:
-- success = false
-- partial = true
-- expected_balance = 6
-- owned_count = 4
-- owned_token_ids = [3, 4, 5, 6]
-- scan_complete = false
-- prune_applied = false
-- warning_code = 'TRANSFER_LOG_DISCOVERY_INCOMPLETE'

-- Main benefit:
-- Users with multiple Base gear NFTs can manually sync without losing
-- already-synced gear during temporary RPC or log discovery failures.
