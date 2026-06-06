const CACHE_NAME = "wholesaleledger-static-v7";
const APP_SHELL = [
  "./",
  "./index.html",
  "./clients.html",
  "./client-detail.html",
  "./settings.html",
  "./offline.html",
  "./manifest.json",
  "./css/base.css",
  "./css/dashboard.css",
  "./css/clients.css",
  "./css/client-detail.css",
  "./css/settings.css",
  "./js/db.js",
  "./js/vendor-idb.js",
  "./js/notify.js",
  "./js/export.js",
  "./js/sse.js",
  "./js/dashboard.js",
  "./js/clients.js",
  "./js/client-detail.js",
  "./js/settings.js",
  "./js/vendor/idb.umd.js",
  "./js/vendor/xlsx.full.min.js",
  "./js/vendor/jspdf.umd.min.js",
  "./js/vendor/jspdf.plugin.autotable.min.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL);
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  if (request.url.includes("/api/") || request.headers.get("accept")?.includes("text/event-stream") || request.url.includes("/events")) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

self.addEventListener("sync", (event) => {
  if (event.tag === "sync-payment-confirmations") {
    event.waitUntil(markQueuedActionsSynced());
  }
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && shouldCache(request, response)) {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    return (await caches.match(request)) || (await caches.match("./offline.html"));
  }
}

function shouldCache(request, response) {
  const url = new URL(request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return response.type === "basic" || response.type === "cors";
}

function openLedgerDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("WholesaleLedgerDB", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function getApiBaseUrl(db) {
  const settings = await getByKey(db, "settings", "global");
  if (!settings || !settings.sse_endpoint) return "";
  return settings.sse_endpoint.replace(/\/sse\/?$/, "");
}

function getByKey(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).get(key);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function markQueuedActionsSynced() {
  const db = await openLedgerDb();
  const queued = await getAll(db, "sync_queue");
  const apiBase = await getApiBaseUrl(db);
  if (!apiBase) {
    console.warn("[SW] No API base URL found in settings, skipping sync");
    return;
  }
  const tx = db.transaction("sync_queue", "readwrite");
  const store = tx.objectStore("sync_queue");
  for (const item of queued) {
    if (item.status !== "queued") continue;
    try {
      let url = "";
      let options = {
        method: "GET",
        headers: { "Content-Type": "application/json" }
      };
      if (item.type === "client_added") {
        url = `${apiBase}/api/clients`;
        options.method = "POST";
        options.body = JSON.stringify(item.payload);
      } else if (item.type === "payment_added") {
        url = `${apiBase}/api/payments`;
        options.method = "POST";
        options.body = JSON.stringify(item.payload);
      } else if (item.type === "payment_confirmed") {
        url = `${apiBase}/api/payments/${item.payload.id}/confirm`;
        options.method = "PUT";
        options.body = JSON.stringify(item.payload);
      } else if (item.type === "payment_discarded") {
        url = `${apiBase}/api/payments/${item.payload.payment_id}`;
        options.method = "DELETE";
      }
      if (url) {
        console.log(`[SW] Syncing action ${item.type} to ${url}...`);
        const response = await fetch(url, options);
        if (!response.ok) {
          throw new Error(`Server returned ${response.status}`);
        }
        await store.put({ ...item, status: "synced", synced_at: Date.now() });
      }
    } catch (error) {
      console.error(`[SW] Failed to sync action ${item.type}:`, error);
    }
  }
  await transactionDone(tx);
}

function getAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result || []);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
