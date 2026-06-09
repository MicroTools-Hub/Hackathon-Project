/* ──────────────────────────────────────────────────────────
   WLSync  –  Offline-first sync layer (IndexedDB ↔ Supabase)
   Exposed at window.WLSync
   ────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // ── Config ────────────────────────────────────────────
  const PUSH_INTERVAL = 10000;  // 10 seconds
  const PULL_INTERVAL = 30000;  // 30 seconds
  const DB_NAME      = 'WholesaleLedgerDB';
  const DB_VERSION   = 1;
  const SYNC_TABLES  = ['businesses', 'clients', 'invoices', 'payments'];

  const ALLOWED_FIELDS = {
    businesses: ['id', 'name', 'prefix', 'owner_number', 'created_at'],
    clients: ['id', 'business_id', 'name', 'phone', 'credit_limit', 'payment_cycle_days', 'created_at'],
    invoices: ['id', 'business_id', 'client_id', 'amount', 'due_date', 'status', 'notes', 'source', 'source_number', 'raw_input', 'confidence', 'transaction_id', 'business_prefix', 'client_name', 'created_at'],
    payments: ['id', 'business_id', 'client_id', 'invoice_id', 'amount', 'mode', 'recorded_at', 'source', 'source_number', 'raw_input', 'confidence', 'status', 'utr_number', 'notes', 'business_prefix', 'client_name', 'match_score', 'created_at']
  };


  // ── State ─────────────────────────────────────────────
  let pushTimer  = null;
  let pullTimer  = null;
  let status     = 'idle';   // 'idle' | 'syncing' | 'synced' | 'offline' | 'error'
  let isRunning  = false;

  // ── Helpers ───────────────────────────────────────────

  /** @returns {import('@supabase/supabase-js').SupabaseClient | null} */
  function getSupabase() {
    return window.WLAuth?.getClient() || null;
  }

  /** @returns {Promise<string|null>} */
  async function getUserId() {
    try {
      const user = await window.WLAuth?.getUser();
      return user?.id || null;
    } catch (err) {
      console.warn('[Sync] Could not get user id:', err.message);
      return null;
    }
  }

  /** Update all sync indicators on the page. */
  function updateSyncUI(newStatus) {
    const indicator = document.querySelector('[data-sync-status]');
    if (!indicator) return;

    // Remove all status classes
    indicator.classList.remove('is-syncing', 'is-synced', 'is-offline', 'is-error', 'is-idle');

    // Add correct state class
    if (newStatus === 'syncing') indicator.classList.add('is-syncing');
    else if (newStatus === 'synced') indicator.classList.add('is-synced');
    else if (newStatus === 'offline') indicator.classList.add('is-offline');
    else if (newStatus === 'error') indicator.classList.add('is-error');
    else indicator.classList.add('is-idle');

    // Update text label
    const label = indicator.querySelector('[data-sync-label]');
    if (label) {
      if (newStatus === 'syncing') label.textContent = 'Syncing...';
      else if (newStatus === 'synced') label.textContent = 'Synced';
      else if (newStatus === 'offline') label.textContent = 'Offline';
      else if (newStatus === 'error') label.textContent = 'Sync Error';
      else label.textContent = 'Sync';
    }
  }

  /** Broadcast status changes via CustomEvent. */
  function setStatus(newStatus) {
    status = newStatus;
    window.dispatchEvent(
      new CustomEvent('wl:sync-status', { detail: { status } })
    );
    updateSyncUI(newStatus);
  }

  /** Open the IndexedDB handle via idb. */
  async function openDb() {
    if (typeof idb === 'undefined' || !idb.openDB) {
      throw new Error('idb library is not loaded');
    }
    return idb.openDB(DB_NAME, DB_VERSION);
  }

  /**
   * Safely convert a timestamp to ISO-8601.
   * Returns the original value if conversion fails.
   */
  function toISO(value) {
    if (!value) return value;
    if (typeof value === 'number') {
      return new Date(value).toISOString();
    }
    if (typeof value === 'string') {
      // Already ISO – validate quickly
      const d = new Date(value);
      return isNaN(d.getTime()) ? value : d.toISOString();
    }
    return value;
  }

  /**
   * Convert a date-like value to epoch ms (number) for local storage.
   */
  function toEpoch(value) {
    if (!value) return value;
    if (typeof value === 'number') return value;
    const d = new Date(value);
    return isNaN(d.getTime()) ? value : d.getTime();
  }

  // ── PUSH: local → cloud ──────────────────────────────

  async function push() {
    const sb     = getSupabase();
    const userId = await getUserId();

    if (!sb)            { console.log('[Sync] Push skipped — no Supabase client'); return; }
    if (!userId)        { console.log('[Sync] Push skipped — no user');            return; }
    if (!navigator.onLine) { console.log('[Sync] Push skipped — offline');         return; }

    let db;
    try {
      db = await openDb();
    } catch (err) {
      console.error('[Sync] Push — cannot open DB:', err);
      return;
    }

    // Self-healing check: If the active business doesn't exist in Supabase (e.g. database reset),
    // mark all local records as unsynced so they get re-pushed.
    const activeBusiness = window.WLDB ? await window.WLDB.getActiveBusiness() : null;
    const activeBusinessId = activeBusiness?.id || null;
    if (activeBusinessId) {
      try {
        const { data, error } = await sb
          .from('businesses')
          .select('id')
          .eq('id', activeBusinessId)
          .maybeSingle();

        if (!error && !data) {
          console.log('[Sync] Active business not found in Supabase (database reset?), force-marking local data as unsynced for re-push...');
          for (const table of SYNC_TABLES) {
            const tx = db.transaction(table, 'readwrite');
            const allRecords = await tx.store.getAll();
            for (const record of allRecords) {
              if (record.synced !== false) {
                await tx.store.put({ ...record, synced: false });
              }
            }
            await tx.done;
          }
          console.log('[Sync] All local records marked as unsynced successfully.');
        }
      } catch (err) {
        console.warn('[Sync] Failed to verify active business existence in Supabase:', err);
      }
    }


    for (const table of SYNC_TABLES) {
      let all;
      try {
        all = await db.getAll(table);
      } catch (err) {
        console.warn(`[Sync] Push — could not read "${table}":`, err.message);
        continue;
      }

      const unsynced = all.filter(r => r.synced === false);
      if (unsynced.length === 0) continue;

      // Prepare records for Supabase upsert (filter to only include allowed schema fields)
      const records = unsynced.map(r => {
        const clean = {};
        const allowed = ALLOWED_FIELDS[table];
        for (const field of allowed) {
          if (r[field] !== undefined) {
            clean[field] = r[field];
          }
        }
        clean.user_id = userId;

        // Convert created_at to ISO if stored as epoch number
        if (typeof clean.created_at === 'number') {
          clean.created_at = toISO(clean.created_at);
        }

        // Let Supabase trigger handle updated_at
        delete clean.updated_at;

        return clean;
      });


      try {
        const { error } = await sb.from(table).upsert(records, { onConflict: 'id' });

        if (!error) {
          // Mark as synced locally
          const tx = db.transaction(table, 'readwrite');
          for (const record of unsynced) {
            await tx.store.put({
              ...record,
              synced: true,
              updated_at: new Date().toISOString(),
            });
          }
          await tx.done;
          console.log(`[Sync] ✓ Pushed ${records.length} ${table} record(s)`);
        } else {
          console.error(`[Sync] Push error for "${table}":`, error.message || error);
        }
      } catch (err) {
        console.error(`[Sync] Push network error for "${table}":`, err);
      }
    }
  }

  // ── PULL: cloud → local ──────────────────────────────

  async function pull() {
    const sb     = getSupabase();
    const userId = await getUserId();

    if (!sb)            { console.log('[Sync] Pull skipped — no Supabase client'); return; }
    if (!userId)        { console.log('[Sync] Pull skipped — no user');            return; }
    if (!navigator.onLine) { console.log('[Sync] Pull skipped — offline');         return; }

    const lastSync = localStorage.getItem('wl_last_sync_time') || '1970-01-01T00:00:00Z';

    let db;
    try {
      db = await openDb();
    } catch (err) {
      console.error('[Sync] Pull — cannot open DB:', err);
      return;
    }

    let totalPulled = 0;

    for (const table of SYNC_TABLES) {
      try {
        const { data, error } = await sb
          .from(table)
          .select('*')
          .gt('updated_at', lastSync)
          .order('updated_at', { ascending: true });

        if (error) {
          console.error(`[Sync] Pull error for "${table}":`, error.message || error);
          continue;
        }
        if (!data || data.length === 0) continue;

        const tx = db.transaction(table, 'readwrite');
        for (const cloudRecord of data) {
          const local     = await tx.store.get(cloudRecord.id);
          const cloudTime = new Date(cloudRecord.updated_at).getTime();
          const localTime = local?.updated_at ? new Date(local.updated_at).getTime() : 0;

          if (!local || cloudTime > localTime) {
            // Cloud is newer or record doesn't exist locally — merge/overwrite
            const merged = {
              ...local,
              ...cloudRecord,
              synced: true,
              // Keep created_at as epoch number for IndexedDB compat
              created_at: toEpoch(cloudRecord.created_at),
            };
            // user_id is not needed locally
            delete merged.user_id;
            await tx.store.put(merged);
            totalPulled++;
          }

          // If local is newer, skip — next push cycle will handle it
        }
        await tx.done;
      } catch (err) {
        console.error(`[Sync] Pull network error for "${table}":`, err);
      }
    }

    // Update last sync timestamp
    localStorage.setItem('wl_last_sync_time', new Date().toISOString());

    if (totalPulled > 0) {
      console.log(`[Sync] ✓ Pulled ${totalPulled} record(s) from cloud`);
      window.dispatchEvent(new CustomEvent('wl:sync-completed'));
    }
  }

  // ── Full sync cycle ──────────────────────────────────

  async function syncNow() {
    if (status === 'syncing') {
      console.log('[Sync] Sync already in progress — skipping');
      return;
    }

    setStatus('syncing');

    try {
      await push();
      await pull();
      setStatus('synced');
    } catch (err) {
      console.error('[Sync] Sync cycle failed:', err);
      setStatus('error');
    }
  }

  // ── Initial pull (login / first-time sync) ───────────

  async function initialPull() {
    const sb     = getSupabase();
    const userId = await getUserId();

    if (!sb || !userId) {
      console.warn('[Sync] initialPull skipped — missing client or user');
      return;
    }

    console.log('[Sync] Starting initial pull …');
    setStatus('syncing');

    let db;
    try {
      db = await openDb();
    } catch (err) {
      console.error('[Sync] initialPull — cannot open DB:', err);
      setStatus('error');
      return;
    }

    let totalRecords = 0;

    for (const table of SYNC_TABLES) {
      try {
        const { data, error } = await sb.from(table).select('*');

        if (error) {
          console.error(`[Sync] initialPull error for "${table}":`, error.message || error);
          continue;
        }
        if (!data || data.length === 0) continue;

        const tx = db.transaction(table, 'readwrite');
        for (const record of data) {
          const local = await tx.store.get(record.id);
          const merged = {
            ...local,
            ...record,
            synced: true,
            created_at: toEpoch(record.created_at),
          };
          delete merged.user_id;
          await tx.store.put(merged);
        }
        await tx.done;

        totalRecords += data.length;
      } catch (err) {
        console.error(`[Sync] initialPull network error for "${table}":`, err);
      }
    }

    localStorage.setItem('wl_last_sync_time', new Date().toISOString());
    setStatus('synced');
    window.dispatchEvent(new CustomEvent('wl:sync-completed'));
    console.log(`[Sync] ✓ Initial pull completed — ${totalRecords} record(s)`);
  }

  // ── Start / Stop ─────────────────────────────────────

  function start() {
    if (isRunning) {
      console.log('[Sync] Already running');
      return;
    }
    isRunning = true;
    console.log('[Sync] Starting sync engine');

    if (!navigator.onLine) {
      setStatus('offline');
      console.log('[Sync] Device is offline — will sync when connection returns');
      return;
    }

    // Periodic push
    pushTimer = setInterval(() => {
      if (navigator.onLine) push().catch(console.error);
    }, PUSH_INTERVAL);

    // Periodic pull
    pullTimer = setInterval(() => {
      if (navigator.onLine) pull().catch(console.error);
    }, PULL_INTERVAL);

    // Immediate full sync
    syncNow().catch(console.error);
  }

  function stop() {
    isRunning = false;
    if (pushTimer) clearInterval(pushTimer);
    if (pullTimer) clearInterval(pullTimer);
    pushTimer = null;
    pullTimer = null;
    setStatus('idle');
    console.log('[Sync] Stopped');
  }

  // ── Online / Offline listeners ────────────────────────

  window.addEventListener('online', () => {
    console.log('[Sync] Back online');
    if (isRunning) {
      syncNow().catch(console.error);
    } else {
      setStatus('idle');
    }
  });

  window.addEventListener('offline', () => {
    console.log('[Sync] Went offline');
    setStatus('offline');
  });

  // ── Public API ────────────────────────────────────────

  window.WLSync = {
    start,
    stop,
    syncNow,
    initialPull,
    push,
    pull,
    getStatus: () => status,
  };

  // ── DOM Init ──────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    updateSyncUI(status);
  });

  console.log('[Sync] Module loaded');
})();
